const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Enable CORS for GitHub Pages and local development
app.use(cors({
    origin: '*', // In production, replace with your GitHub Pages URL
    credentials: true
}));

app.use(express.json());

// In-memory storage for rooms
const rooms = new Map();

// Store WebSocket connections by room code
const connections = new Map();

// Helper function to generate unique user ID
function generateUserId() {
    return Math.random().toString(36).substring(2, 15);
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
        version: '1.0.0',
        activeRooms: rooms.size,
        totalConnections: Array.from(connections.values()).reduce((sum, room) => sum + room.size, 0)
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

    const room = {
        code: roomCode,
        videoId: videoId,
        host: hostName || 'Host',
        createdAt: Date.now(),
        state: {
            playing: false,
            currentTime: 0,
            timestamp: Date.now()
        },
        viewers: []
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
            viewerCount: viewerCount
        }
    });
});

// REST API: List all active rooms (for debugging)
app.get('/api/rooms', (req, res) => {
    const roomList = Array.from(rooms.values()).map(room => {
        const roomConnections = connections.get(room.code);
        return {
            code: room.code,
            videoId: room.videoId,
            host: room.host,
            viewerCount: roomConnections ? roomConnections.size : 0,
            createdAt: room.createdAt
        };
    });

    res.json({
        success: true,
        rooms: roomList,
        totalRooms: rooms.size
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

        // Add connection to room
        if (!connections.has(roomCode)) {
            connections.set(roomCode, new Set());
        }
        
        const roomConnections = connections.get(roomCode);
        roomConnections.add({ ws, userId, username });
        currentRoomCode = roomCode;

        console.log(`👤 ${username} (${userId}) joined room ${roomCode}`);

        // Send success message to user
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

    function handleLeaveRoom(userId) {
        if (!currentRoomCode) return;

        const roomConnections = connections.get(currentRoomCode);
        if (roomConnections) {
            // Remove user from room
            roomConnections.forEach((conn) => {
                if (conn.userId === userId) {
                    roomConnections.delete(conn);
                }
            });

            console.log(`👋 User ${userId} left room ${currentRoomCode}`);

            // Notify remaining users
            broadcastToRoomAll(currentRoomCode, {
                type: 'viewer_update',
                viewerCount: roomConnections.size
            });

            // Clean up empty rooms
            if (roomConnections.size === 0) {
                connections.delete(currentRoomCode);
                rooms.delete(currentRoomCode);
                console.log(`🗑️  Room ${currentRoomCode} deleted (empty)`);
            }
        }

        currentRoomCode = null;
    }

    function handleDisconnect(userId) {
        console.log(`🔌 WebSocket disconnected: ${userId}`);
        handleLeaveRoom(userId);
    }
});

// Cleanup old rooms every 10 minutes
setInterval(() => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    rooms.forEach((room, roomCode) => {
        const age = now - room.createdAt;
        const roomConnections = connections.get(roomCode);
        
        // Delete room if it's old and empty
        if (age > maxAge && (!roomConnections || roomConnections.size === 0)) {
            rooms.delete(roomCode);
            connections.delete(roomCode);
            console.log(`🗑️  Cleaned up old room: ${roomCode}`);
        }
    });
}, 10 * 60 * 1000);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║       RON'S ROOMS - BACKEND SERVER     ║
╚════════════════════════════════════════╝

🚀 Server running on port ${PORT}
🌐 HTTP: http://localhost:${PORT}
🔌 WebSocket: ws://localhost:${PORT}

Ready to sync watch parties! ✨
    `);
});
