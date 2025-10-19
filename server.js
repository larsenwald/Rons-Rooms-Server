const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors({
    origin: '*',
    credentials: true
}));

app.use(express.json());

// In-memory storage for rooms
const rooms = new Map();

// Store WebSocket connections by room code
const connections = new Map();

// INACTIVITY TIMEOUT: 20 minutes in milliseconds
const INACTIVITY_TIMEOUT = 20 * 60 * 1000;

// Helper function to generate unique user ID
function generateUserId() {
    return Math.random().toString(36).substring(2, 15);
}

// Helper function to update room activity
function updateRoomActivity(roomCode) {
    const room = rooms.get(roomCode);
    if (room) {
        room.lastActivity = Date.now();
        console.log(`🕐 Room ${roomCode} activity updated`);
    }
}

// Helper function to broadcast to all users in a room except sender
function broadcastToRoom(roomCode, data, senderId) {
    const roomConnections = connections.get(roomCode);
    if (!roomConnections) return;

    roomConnections.forEach((conn) => {
        if (conn.userId !== senderId && conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(JSON.stringify(data));
        }
    });
}

// Helper function to send to all users in a room including sender
function broadcastToRoomAll(roomCode, data) {
    const roomConnections = connections.get(roomCode);
    if (!roomConnections) return;

    roomConnections.forEach((conn) => {
        if (conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(JSON.stringify(data));
        }
    });
}

// REST API: Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Ron\'s Rooms Backend',
        version: '2.0.0',
        activeRooms: rooms.size,
        totalConnections: Array.from(connections.values()).reduce((sum, room) => sum + room.size, 0),
        features: {
            syncAcknowledgment: true,
            inactivityTimeout: '20 minutes',
            smartRoomCleanup: true
        }
    });
});

// REST API: Create room
app.post('/api/rooms/create', (req, res) => {
    const { roomCode, videoId, hostName } = req.body;

    if (!roomCode || !videoId) {
        return res.status(400).json({ error: 'Room code and video ID required' });
    }

    if (rooms.has(roomCode)) {
        return res.status(409).json({ error: 'Room code already exists' });
    }

    const now = Date.now();
    
    const room = {
        code: roomCode,
        videoId: videoId,
        host: hostName || 'Host',
        createdAt: now,
        lastActivity: now,
        state: {
            action: 'pause',
            currentTime: 0,
            timestamp: now
        },
        viewers: [],
        syncedViewers: new Set() // Track which viewers have acknowledged sync
    };

    rooms.set(roomCode, room);
    connections.set(roomCode, new Set());

    console.log(`✅ Room created: ${roomCode} (Video: ${videoId})`);

    res.json({
        success: true,
        room: {
            code: room.code,
            videoId: room.videoId,
            host: room.host
        }
    });
});

// REST API: Get room info
app.get('/api/rooms/:roomCode', (req, res) => {
    const { roomCode } = req.params;
    const room = rooms.get(roomCode.toUpperCase());

    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const roomConnections = connections.get(roomCode.toUpperCase());
    const viewerCount = roomConnections ? roomConnections.size : 0;

    res.json({
        success: true,
        room: {
            code: room.code,
            videoId: room.videoId,
            host: room.host,
            state: room.state,
            viewerCount: viewerCount,
            lastActivity: room.lastActivity
        }
    });
});

// REST API: List all active rooms (for debugging)
app.get('/api/rooms', (req, res) => {
    const now = Date.now();
    const roomList = Array.from(rooms.values()).map(room => {
        const roomConnections = connections.get(room.code);
        const inactiveDuration = now - room.lastActivity;
        const isInactive = inactiveDuration > INACTIVITY_TIMEOUT;
        
        return {
            code: room.code,
            videoId: room.videoId,
            host: room.host,
            viewerCount: roomConnections ? roomConnections.size : 0,
            createdAt: room.createdAt,
            lastActivity: room.lastActivity,
            inactiveMinutes: Math.floor(inactiveDuration / 60000),
            willDeleteSoon: isInactive && (!roomConnections || roomConnections.size === 0),
            state: room.state
        };
    });

    res.json({
        success: true,
        rooms: roomList,
        totalRooms: rooms.size,
        inactivityTimeout: '20 minutes'
    });
});

// WebSocket connection handler
wss.on('connection', (ws) => {
    let currentRoomCode = null;
    let userId = generateUserId();

    console.log(`🔌 New WebSocket connection: ${userId}`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'join':
                    handleJoinRoom(ws, data, userId);
                    break;

                case 'sync':
                    handleSync(data, userId);
                    break;

                case 'sync_ack':
                    handleSyncAcknowledgment(data, userId);
                    break;

                case 'leave':
                    handleLeaveRoom(userId);
                    break;

                default:
                    console.log(`❓ Unknown message type: ${data.type}`);
            }
        } catch (error) {
            console.error('❌ Error parsing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
        }
    });

    ws.on('close', () => {
        handleDisconnect(userId);
    });

    ws.on('error', (error) => {
        console.error(`❌ WebSocket error for ${userId}:`, error);
    });

    function handleJoinRoom(ws, data, userId) {
        const roomCode = data.roomCode.toUpperCase();
        const username = data.username || 'Guest';
        const room = rooms.get(roomCode);

        if (!room) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Room not found'
            }));
            return;
        }

        // Update room activity when someone joins
        updateRoomActivity(roomCode);

        // Add connection to room
        if (!connections.has(roomCode)) {
            connections.set(roomCode, new Set());
        }
        
        const roomConnections = connections.get(roomCode);
        roomConnections.add({ ws, userId, username });
        currentRoomCode = roomCode;

        console.log(`👤 ${username} (${userId}) joined room ${roomCode}`);
        console.log(`📊 Current room state:`, room.state);

        // Send current state to joining user
        ws.send(JSON.stringify({
            type: 'joined',
            roomCode: roomCode,
            videoId: room.videoId,
            state: room.state,
            viewerCount: roomConnections.size
        }));

        // Notify all users in room about new viewer
        broadcastToRoomAll(roomCode, {
            type: 'viewer_update',
            viewerCount: roomConnections.size
        });
    }

    function handleSync(data, userId) {
        if (!currentRoomCode) return;

        const room = rooms.get(currentRoomCode);
        if (!room) return;

        // Update room activity on ANY playback action (play, pause, seek)
        updateRoomActivity(currentRoomCode);

        // Clear synced viewers set - everyone needs to re-acknowledge
        room.syncedViewers.clear();

        // Update room state
        room.state = {
            action: data.action,
            currentTime: data.currentTime,
            timestamp: Date.now()
        };

        console.log(`🔄 Sync from ${userId} in ${currentRoomCode}: ${data.action} at ${data.currentTime.toFixed(2)}s`);

        // Broadcast to all other users in room
        broadcastToRoom(currentRoomCode, {
            type: 'sync',
            action: data.action,
            currentTime: data.currentTime,
            timestamp: room.state.timestamp
        }, userId);
    }

    function handleSyncAcknowledgment(data, userId) {
        if (!currentRoomCode) return;

        const room = rooms.get(currentRoomCode);
        if (!room) return;

        // Add this viewer to synced set
        room.syncedViewers.add(userId);

        const roomConnections = connections.get(currentRoomCode);
        const totalViewers = roomConnections ? roomConnections.size : 0;
        const syncedCount = room.syncedViewers.size;

        console.log(`✓ User ${userId} acknowledged sync in ${currentRoomCode} (${syncedCount}/${totalViewers - 1} synced)`);

        // Notify host about sync acknowledgment
        broadcastToRoom(currentRoomCode, {
            type: 'sync_ack',
            userId: userId,
            syncedCount: syncedCount,
            totalViewers: totalViewers - 1, // Exclude host
            allSynced: syncedCount >= totalViewers - 1
        }, userId);
    }

    function handleLeaveRoom(userId) {
        if (!currentRoomCode) return;

        const roomConnections = connections.get(currentRoomCode);
        const room = rooms.get(currentRoomCode);
        
        if (roomConnections) {
            // Remove user from room
            roomConnections.forEach((conn) => {
                if (conn.userId === userId) {
                    roomConnections.delete(conn);
                }
            });

            // Remove from synced viewers
            if (room) {
                room.syncedViewers.delete(userId);
            }

            console.log(`👋 User ${userId} left room ${currentRoomCode}`);

            // Notify remaining users
            broadcastToRoomAll(currentRoomCode, {
                type: 'viewer_update',
                viewerCount: roomConnections.size
            });

            // CRITICAL: Only delete room if it's completely empty
            if (roomConnections.size === 0) {
                connections.delete(currentRoomCode);
                rooms.delete(currentRoomCode);
                console.log(`🗑️  Room ${currentRoomCode} deleted (empty - 0 viewers)`);
            } else {
                // Room still has people, just update activity
                updateRoomActivity(currentRoomCode);
            }
        }

        currentRoomCode = null;
    }

    function handleDisconnect(userId) {
        console.log(`🔌 WebSocket disconnected: ${userId}`);
        handleLeaveRoom(userId);
    }
});

// ENHANCED CLEANUP: Check rooms every 2 minutes
setInterval(() => {
    const now = Date.now();

    rooms.forEach((room, roomCode) => {
        const roomConnections = connections.get(roomCode);
        const viewerCount = roomConnections ? roomConnections.size : 0;
        const inactiveDuration = now - room.lastActivity;

        // RULE 1: Delete if room is empty (0 viewers)
        if (viewerCount === 0) {
            rooms.delete(roomCode);
            connections.delete(roomCode);
            console.log(`🗑️  Room ${roomCode} deleted - REASON: Empty (0 viewers)`);
            return;
        }

        // RULE 2: Delete if inactive (paused) for 20+ minutes
        if (inactiveDuration > INACTIVITY_TIMEOUT) {
            // Notify all viewers that room is closing due to inactivity
            broadcastToRoomAll(roomCode, {
                type: 'room_closing',
                reason: 'inactivity',
                message: 'Room closed due to 20 minutes of inactivity'
            });

            // Close all connections gracefully
            if (roomConnections) {
                roomConnections.forEach((conn) => {
                    if (conn.ws.readyState === WebSocket.OPEN) {
                        conn.ws.close(1000, 'Room closed due to inactivity');
                    }
                });
            }

            rooms.delete(roomCode);
            connections.delete(roomCode);
            
            const inactiveMinutes = Math.floor(inactiveDuration / 60000);
            console.log(`🗑️  Room ${roomCode} deleted - REASON: Inactive for ${inactiveMinutes} minutes (no playback activity)`);
        }
    });

    // Log cleanup summary
    const activeRooms = rooms.size;
    if (activeRooms > 0) {
        console.log(`\n📊 Cleanup cycle complete - ${activeRooms} active rooms remaining`);
        rooms.forEach((room, code) => {
            const inactiveMinutes = Math.floor((now - room.lastActivity) / 60000);
            const roomConns = connections.get(code);
            const viewers = roomConns ? roomConns.size : 0;
            console.log(`   - ${code}: ${viewers} viewers, inactive for ${inactiveMinutes}m`);
        });
    }
}, 2 * 60 * 1000); // Check every 2 minutes

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║    RON'S ROOMS - ENHANCED BACKEND      ║
╚════════════════════════════════════════╝

🚀 Server running on port ${PORT}
🌐 HTTP: http://localhost:${PORT}
🔌 WebSocket: ws://localhost:${PORT}

✨ Features:
   - Sync Acknowledgment System
   - Smart Room Cleanup
   - 20-Minute Inactivity Timeout
   - Real-time Activity Tracking

Ready to sync watch parties! 🎬
    `);
});