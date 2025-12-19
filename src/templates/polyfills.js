export const simpleLoggerJs = `
(function() {
  // Enhanced logger that forwards console events to Devvit host
  const _log = console.log;
  const _warn = console.warn;
  const _error = console.error;
  const _info = console.info;
  
  function post(level, args) {
    try {
      // Robust serialization to string for Devvit consumption
      const serialized = args.map(a => {
        if (a === undefined) return 'undefined';
        if (a === null) return 'null';
        if (a instanceof Error) return '[Error: ' + (a.message || 'unknown') + ']\\n' + (a.stack || '');
        if (typeof a === 'object') {
            try { 
                return JSON.stringify(a, (key, value) => {
                    if (typeof value === 'function') return '[Function]';
                    return value;
                }); 
            } catch(e) { return '[Circular/Object]'; }
        }
        return String(a);
      });
      
      // Send to parent (Devvit WebView wrapper)
      window.parent.postMessage({ type: 'console', level, args: serialized }, '*');
      
    } catch(e) {
        // Fallback
    }
  }

  // Override console methods
  console.log = function(...args) { _log.apply(console, args); post('info', args); };
  console.info = function(...args) { _info.apply(console, args); post('info', args); };
  console.warn = function(...args) { _warn.apply(console, args); post('warn', args); };
  console.error = function(...args) { _error.apply(console, args); post('error', args); };

  // Global Error Handler
  window.addEventListener('error', function(e) {
    post('error', ['[Uncaught Exception]', e.message, 'at', e.filename, ':', e.lineno, 'col', e.colno]);
  });
  
  // Promise Rejection Handler
  window.addEventListener('unhandledrejection', function(e) {
    post('error', ['[Unhandled Promise Rejection]', e.reason ? (e.reason.message || e.reason) : 'Unknown']);
  });

  // --- AudioContext Autoplay Fix ---
  // Browsers block AudioContext autoplay. We hook into creation to resume on first interaction.
  try {
      const _AudioContext = window.AudioContext || window.webkitAudioContext;
      if (_AudioContext) {
          const contexts = new Set();
          // Polyfill the constructor to track instances
          // We wrap in a try-catch to ensure we don't break the game if native inheritance fails
          class AudioContextPolyfill extends _AudioContext {
              constructor(opts) {
                  super(opts);
                  contexts.add(this);
              }
          }
          
          window.AudioContext = AudioContextPolyfill;
          window.webkitAudioContext = AudioContextPolyfill;
    
          const resumeAll = () => {
              contexts.forEach(ctx => {
                  try {
                      if (ctx.state === 'suspended') {
                          ctx.resume().catch(() => {});
                      }
                  } catch(e) {}
              });
          };
    
          // Listen for any interaction to unlock audio
          ['click', 'touchstart', 'keydown', 'mousedown'].forEach(evt => 
              window.addEventListener(evt, resumeAll, { once: true, capture: true })
          );
      }
  } catch(e) {
      console.warn('[WebSim] AudioContext polyfill failed', e);
  }

  // Signal ready
  console.log('[WebSim Logger] Bridge initialized.');
})();
`;

export const websimSocketPolyfill = `
(function() {
    // Polyfill for WebsimSocket using Devvit Realtime Bridge
    // This allows existing WebSim games to work by proxying events through the Devvit Host.
    
    console.log('[WebSim Socket] Initializing Polyfill...');

    // 1. Mock Data Structures for Global State
    // These need to be globally consistent for the polyfill to simulate a room
    const _roomState = {};
    const _presence = {};
    const _peers = {};
    const _clientId = Math.random().toString(36).substr(2, 9);
    
    // Initialize self in peers
    _peers[_clientId] = { 
        username: 'Player ' + _clientId.substr(0,4), 
        avatarUrl: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png',
        id: _clientId 
    };
    _presence[_clientId] = {};

    function WebsimSocket() {
        if (!(this instanceof WebsimSocket)) return new WebsimSocket();
        
        this.clientId = _clientId;
        this.roomState = _roomState;
        this.presence = _presence;
        this.peers = _peers;
        this.listeners = {};
        this.connected = false;
        
        // Listen for messages from Parent (Devvit Host)
        window.addEventListener('message', (e) => {
            if (!e.data || e.data.type !== 'WEBSIM_SOCKET_EVT') return;
            
            const { type, payload, senderId } = e.data.payload || {};
            
            if (senderId === this.clientId) return;

            this._handleRemoteEvent(type, payload, senderId);
        });
    }

    WebsimSocket.prototype.initialize = async function() {
        console.log('[WebSim Socket] Connecting...');
        this.connected = true;
        
        this._sendInternal('join', { 
            username: this.peers[this.clientId].username,
            avatarUrl: this.peers[this.clientId].avatarUrl
        });
        
        return new Promise(resolve => setTimeout(resolve, 50));
    };

    WebsimSocket.prototype.updatePresence = function(update) {
        const current = this.presence[this.clientId] || {};
        this.presence[this.clientId] = { ...current, ...update };
        this._emit('presence', this.presence);
        this._sendInternal('presence_update', update);
    };

    WebsimSocket.prototype.updateRoomState = function(update) {
        Object.assign(this.roomState, update);
        this._emit('roomState', this.roomState);
        this._sendInternal('room_state_update', update);
    };
    
    WebsimSocket.prototype.requestPresenceUpdate = function(targetClientId, data) {
         this._sendInternal('request_presence', { targetClientId, data });
    };

    WebsimSocket.prototype.send = function(eventData) {
        this._sendInternal('broadcast_event', eventData);
    };
    
    WebsimSocket.prototype.emit = function(event, data) {
        this.send({ type: event, ...data });
    };
    
    WebsimSocket.prototype.onmessage = function(event) {
        console.log('[WebSim Socket] Message received:', event);
    };

    WebsimSocket.prototype.subscribePresence = function(callback) {
        return this._on('presence', callback);
    };

    WebsimSocket.prototype.subscribeRoomState = function(callback) {
        return this._on('roomState', callback);
    };
    
    WebsimSocket.prototype.subscribePresenceUpdateRequests = function(callback) {
        return this._on('presence_request', callback);
    };

    WebsimSocket.prototype._sendInternal = function(msgType, data) {
        window.parent.postMessage({
            type: 'WEBSIM_SOCKET_MSG',
            payload: {
                type: msgType,
                payload: data,
                senderId: this.clientId
            }
        }, '*');
    };

    WebsimSocket.prototype._handleRemoteEvent = function(type, data, senderId) {
        if (!this.peers[senderId]) {
            this.peers[senderId] = { 
                id: senderId, 
                username: 'User ' + senderId.substr(0,4),
                avatarUrl: ''
            };
        }

        switch(type) {
            case 'join':
                this.peers[senderId] = { ...this.peers[senderId], ...data };
                this._sendInternal('presence_update', this.presence[this.clientId] || {});
                break;
            case 'presence_update':
                this.presence[senderId] = { ...(this.presence[senderId] || {}), ...data };
                this._emit('presence', this.presence);
                break;
            case 'room_state_update':
                Object.assign(this.roomState, data);
                this._emit('roomState', this.roomState);
                break;
            case 'broadcast_event':
                if (this.onmessage) {
                    this.onmessage({ 
                        data: { 
                            ...data, 
                            clientId: senderId, 
                            username: this.peers[senderId].username 
                        } 
                    });
                }
                break;
            case 'request_presence':
                if (data.targetClientId === this.clientId) {
                    this._emit('presence_request', data.data, senderId);
                }
                break;
        }
    };

    WebsimSocket.prototype._on = function(event, cb) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(cb);
        return () => {
            this.listeners[event] = this.listeners[event].filter(x => x !== cb);
        };
    };

    WebsimSocket.prototype._emit = function(event, ...args) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => {
                try { cb(...args); } catch(e) { console.error(e); }
            });
        }
    };

    // Expose Global
    window.WebsimSocket = WebsimSocket;
    
    // Also polyfill 'party' object if used by older games
    // Some games use party.room, others use party as the socket itself.
    if (!window.party) {
        window.party = new WebsimSocket();
        // Alias for games that expect party.room to be the socket
        window.party.room = window.party;
    }
})();
`;

export const websimStubsJs = `
// WebSim API Stubs for standalone running
(function() {
    if (!window.websim) {
      window.websim = {
        getCurrentUser: async () => ({
            id: 'user_' + Math.random().toString(36).substr(2,9),
            username: 'Player',
            avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
        }),
        getProject: async () => ({
            id: 'local_project',
            title: 'Local Game'
        })
      };
    }
})();
`;

