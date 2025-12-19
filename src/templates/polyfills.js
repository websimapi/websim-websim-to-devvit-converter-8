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
          ['click', 'touchstart', 'pointerdown', 'keydown', 'mousedown'].forEach(evt => 
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
// WebSim Socket Polyfill -> Reddit Devvit Realtime Bridge
// This module bridges the WebSim "Room" API to Reddit's Realtime Channels.
// It uses a postMessage bridge to the parent Devvit Block which handles the actual Realtime connection.

console.log('[WebSim Socket] Initializing Realtime Bridge...');

// Global State (Synced with Room)
const _roomState = {};
const _presence = {};
const _peers = {};
const _clientId = Math.random().toString(36).substr(2, 9); // Temporary ID until we get real one

// Self Initialization
_peers[_clientId] = { 
    username: 'Player ' + _clientId.substr(0,4), 
    avatarUrl: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png',
    id: _clientId 
};
_presence[_clientId] = {};

class WebsimSocket {
    constructor() {
        this.clientId = _clientId;
        this.roomState = _roomState;
        this.presence = _presence;
        this.peers = _peers;
        this.listeners = {};
        this.connected = false;

        // Listen for messages from Parent (Devvit Host)
        window.addEventListener('message', (e) => {
            // Filter only our bridge events
            if (!e.data || e.data.type !== 'WEBSIM_SOCKET_EVT') return;
            
            const { type, payload, senderId } = e.data.payload || {};
            
            // Ignore echoes from self
            if (senderId === this.clientId) return;

            this._handleRemoteEvent(type, payload, senderId);
        });
    }

    async initialize() {
        console.log('[WebSim Socket] Connecting to room...');
        this.connected = true;
        
        // Announce join to peers
        this._sendInternal('join', { 
            username: this.peers[this.clientId].username,
            avatarUrl: this.peers[this.clientId].avatarUrl
        });
        
        return Promise.resolve();
    }

    updatePresence(update) {
        const current = this.presence[this.clientId] || {};
        this.presence[this.clientId] = { ...current, ...update };
        
        // Optimistic update locally
        this._emit('presence', this.presence);
        
        // Broadcast
        this._sendInternal('presence_update', update);
    }

    updateRoomState(update) {
        Object.assign(this.roomState, update);
        
        // Optimistic update locally
        this._emit('roomState', this.roomState);
        
        // Broadcast
        this._sendInternal('room_state_update', update);
    }

    requestPresenceUpdate(targetClientId, data) {
         this._sendInternal('request_presence', { targetClientId, data });
    }

    send(eventData) {
        this._sendInternal('broadcast_event', eventData);
    }
    
    // Legacy support for socket.emit
    emit(event, data) {
        this.send({ type: event, ...data });
    }
    
    // Default handler, user can override
    onmessage(event) {
        // console.log('[WebSim Socket] Event:', event);
    }

    subscribePresence(callback) {
        return this._on('presence', callback);
    }

    subscribeRoomState(callback) {
        return this._on('roomState', callback);
    }
    
    subscribePresenceUpdateRequests(callback) {
        return this._on('presence_request', callback);
    }

    // INTERNAL: Send to Devvit Parent via postMessage
    _sendInternal(msgType, data) {
        window.parent.postMessage({
            type: 'WEBSIM_SOCKET_MSG',
            payload: {
                type: msgType,
                payload: data,
                senderId: this.clientId
            }
        }, '*');
    }

    // INTERNAL: Handle incoming events from Devvit Parent
    _handleRemoteEvent(type, data, senderId) {
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
                // Reply with our presence so they know about us
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
    }

    _on(event, cb) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(cb);
        return () => {
            this.listeners[event] = this.listeners[event].filter(x => x !== cb);
        };
    }

    _emit(event, ...args) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => {
                try { cb(...args); } catch(e) { console.error(e); }
            });
        }
    }
}

// Singleton Instance
const socket = new WebsimSocket();

// Expose Global (WebSim Standard)
window.WebsimSocket = WebsimSocket;

// Expose 'room' instance globally if not present
// Many WebSim apps use 'const room = new WebsimSocket()' but since we're polyfilling,
// we often need to hook into existing code. 
// For this environment, we just ensure the class is available.

// PartyKit / Multiplayer Polyfills for other common libraries
if (!window.party) {
    window.party = socket;
    window.party.room = socket; // Alias
}

export default socket;
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

export const jsxDevProxy = `
// Shim for react/jsx-dev-runtime to work in production Vite builds
import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';

export const Fragment = _Fragment;
export const jsx = _jsx;
export const jsxs = _jsxs;

// Proxy jsxDEV to jsx (ignores the extra dev-only arguments)
export const jsxDEV = (type, props, key, isStaticChildren, source, self) => {
  return _jsx(type, props, key);
};
`;

