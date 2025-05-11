const express = require('express');
const bodyParser = require('body-parser');
const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const cookieParser = require('cookie-parser');
const path = require('path');
const got = require('got');
const fs = require('fs');
require('dotenv').config(); 


const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });
AWS.config.update({
    region: process.env.AWS_REGION
});
app.use(express.json());
app.use(cors({
    origin: true,
    credentials: true
}));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static("public"));
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});


// ---------------------- Frontend Routes ----------------------
app.get('/', (req, res) => {
    res.sendFile('index.html', { root: './public' });
});


app.get('/radio', (req, res) => {
    // Read the radio.html file
    let radioHtml = fs.readFileSync(path.join(__dirname, 'public', 'radio.html'), 'utf8');
    // Inject the script tag before the closing body tag
    res.send(radioHtml);
});


app.get('/upload', (req, res) => {
    // Read the upload.html file
    let uploadHtml = fs.readFileSync(path.join(__dirname, 'public', 'upload.html'), 'utf8');
    res.send(uploadHtml);
});


app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});


// ---------------------- Cognito ----------------------
const cognito = new AWS.CognitoIdentityServiceProvider();
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET;


// helper function to calculate SECRET_HASH
const calculateSecretHash = (username) => {
    const message = username + CLIENT_ID;
    const hmac = crypto.createHmac('SHA256', CLIENT_SECRET);
    const secretHash = hmac.update(message).digest('base64');
    return secretHash;
};


app.post('/signup', async (req, res) => {
    const { username, email, password } = req.body;
    const params = {
        ClientId: CLIENT_ID, 
        Username: username,
        Password: password,
        SecretHash: calculateSecretHash(username),
        UserAttributes: [
            {
                Name: 'email',
                Value: email
            }
        ]
    };
    try {
        const data = await cognito.signUp(params).promise();
        const cognitoSub = data.UserSub;
        const pool = new Pool({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            ssl: {
                rejectUnauthorized: false
            },
            connectionTimeoutMillis: 5000,
            idleTimeoutMillis: 30000
        });
        await pool.query(
            'INSERT INTO users (cognito_sub, username) VALUES ($1, $2)',
            [cognitoSub, username]
        );
        await pool.end();
        res.json(data);
    } catch (error) {
        console.error('Signup error:', error);
        res.status(400).json({ 
            error: error.message,
            details: error.details || null
        });
    }
});


app.post('/confirm', async (req, res) => {
    const { username, code } = req.body;
    const params = {
        ClientId: CLIENT_ID, 
        Username: username,
        ConfirmationCode: code,
        SecretHash: calculateSecretHash(username)
    };
    try {
        const data = await cognito.confirmSignUp(params).promise();
        res.json(data);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}); 


app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const params = {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: {
            USERNAME: username,
            PASSWORD: password,
            SECRET_HASH: calculateSecretHash(username)
        }
    };
    try {
        const data = await cognito.initiateAuth(params).promise();
        // Set refresh token in HTTP-only cookie
        res.cookie('refreshToken', data.AuthenticationResult.RefreshToken, {
            httpOnly: true,
            secure: false, // for HTTPS
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60 * 1000,  // 30 days
            path: '/'
        });
        // Also store the username in a cookie for refresh token operations
        res.cookie('username', username, {
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60 * 1000,  // 30 days
            path: '/'
        });
        // Send access token in response body
        res.json({
            accessToken: data.AuthenticationResult.AccessToken,
            expiresIn: data.AuthenticationResult.ExpiresIn
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});


app.get('/user-info', async (req, res) => {
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7, authHeader.length);
    }
    if (!token) {
        return res.status(401).json({ error: 'Access token is required' });
    }    
    const params = {
        AccessToken: token
    };
    try {
        const userData = await cognito.getUser(params).promise();
        const username = userData.Username;
        const subAttribute = userData.UserAttributes.find(attr => attr.Name === 'sub');
        const sub = subAttribute ? subAttribute.Value : null;
        res.json({ 
            username,
            sub
        });
    } catch (error) {
        console.error('Get user info error:', error);
        res.status(401).json({ error: 'Invalid or expired token' });
    }
});


app.post('/logout', async (req, res) => {
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7, authHeader.length);
    }
    if (!token) {
        res.clearCookie('refreshToken', { httpOnly: true, secure: true, sameSite: 'strict' });
        res.clearCookie('username', { httpOnly: true, secure: true, sameSite: 'strict' });
        return res.status(401).json({ error: 'Access token is required' });
    }
    const params = {
        AccessToken: token
    };
    try {
        await cognito.globalSignOut(params).promise();
        // Clear the cookies on successful logout
        res.clearCookie('refreshToken', { httpOnly: true, secure: true, sameSite: 'strict' });
        res.clearCookie('username', { httpOnly: true, secure: true, sameSite: 'strict' });
        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        res.clearCookie('refreshToken', { httpOnly: true, secure: true, sameSite: 'strict' });
        res.clearCookie('username', { httpOnly: true, secure: true, sameSite: 'strict' });
        console.error('Logout error:', error); // Log detailed error server-side
        res.status(400).json({ error: 'Logout failed. Please try again.' }); 
    }
});


app.post('/refresh-token', async (req, res) => {
    const refreshToken = req.cookies.refreshToken; // Read from HttpOnly cookie
    const username = req.cookies.username; // Get username from cookie
    if (!refreshToken || !username) {
        return res.status(401).json({ error: 'No refresh token or username provided' });
    }
    const params = {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: {
            REFRESH_TOKEN: refreshToken,
            SECRET_HASH: calculateSecretHash(username)
        }
    };
    try {
        const data = await cognito.initiateAuth(params).promise();
        res.json({
            accessToken: data.AuthenticationResult.AccessToken,
            expiresIn: data.AuthenticationResult.ExpiresIn
        });
    } catch (error) {
        console.error('Refresh token error:', error);
        res.clearCookie('refreshToken', { httpOnly: true, secure: false, sameSite: 'lax' });
        res.clearCookie('username', { httpOnly: true, secure: false, sameSite: 'lax' });
        res.status(401).json({ error: 'Session expired or invalid. Please log in again.' }); 
    }
});


// ---------------------- Radio ----------------------
// Official KUSC Stream URLs directly from kusc.org
const KUSC_STREAM_URLS = [
    'https://playerservices.streamtheworld.com/pls/KUSCAAC96.pls', // High Quality (Recommended)
    'https://playerservices.streamtheworld.com/pls/KUSCAAC32.pls', // High Efficiency (HE-AAC with low data usage)
    'https://playerservices.streamtheworld.com/pls/KUSCMP256.pls'  // Premium Quality (AAC 256kbps)
];


// Route to proxy the radio stream (no server-side pitch shifting)
app.get('/stream-radio', async (req, res) => {
    try {
        // Set appropriate headers
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        console.log(`Attempting to stream from ${KUSC_STREAM_URLS[0]}`);
        // Try to get the primary stream
        let streamResponse;
        try {
            streamResponse = await got.stream(KUSC_STREAM_URLS[0], {
                timeout: { request: 10000 }, retry: { limit: 2 }
            });
        } catch (err) {
            console.log(`Primary stream failed, trying fallback: ${KUSC_STREAM_URLS[1]}`);
            // Try first fallback
            try {
                streamResponse = await got.stream(KUSC_STREAM_URLS[1], {
                    timeout: { request: 10000 }
                });
            } catch (err2) {
                console.log(`Secondary stream failed, trying last resort: ${KUSC_STREAM_URLS[2]}`);
                // Try second fallback (demo station)
                streamResponse = await got.stream(KUSC_STREAM_URLS[2]);
            }
        }
        // Just pipe the stream - we'll do pitch shifting on the client side
        streamResponse.pipe(res);
        // Handle errors
        streamResponse.on('error', (err) => {
            console.error('Stream error:', err);
            if (!res.headersSent) {
                res.status(500).send('Stream error');
            }
        });
    } catch (error) {
        console.error('Error:', error);
        if (!res.headersSent) {
            res.status(500).send('Error connecting to radio stream');
        }
    }
});


// ---------------------- Upload/Download Audio Files ----------------------
// Middleware to verify Cognito token and extract user info
const verifyCognitoToken = async (req, res, next) => {
    console.log('Verifying Cognito token...');
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7, authHeader.length);
    }
    if (!token) {
        // return res.status(401).json({ error: 'No valid token provided' });
        // if no token, continue without userSub and username
        req.userSub = 'non_user';
        req.username = 'na';
        next();
        return;
    }
    try {
        const params = {
            AccessToken: token
        };
        const userData = await cognito.getUser(params).promise();
        const subAttribute = userData.UserAttributes.find(attr => attr.Name === 'sub');
        if (!subAttribute) {
            return res.status(401).json({ error: 'Could not identify user from token' });
        }
        req.userSub = subAttribute.Value;
        req.username = userData.Username;
        next();
    } catch (error) {
        // console.error('Token verification error:', error);
        // res.status(401).json({ error: 'Invalid or expired token' });
        // if token verification fails, continue without userSub and username
        req.userSub = 'non_user';
        req.username = 'na';
        next();
    }
};


// Route to handle file upload and trigger Lambda processing
app.post('/upload-audio', verifyCognitoToken, upload.single('audio'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }    
    try {
        // Basic validation on file type and size
        if (!req.file.mimetype.startsWith('audio/')) {
            return res.status(400).json({ error: 'Only audio files are allowed' });
        }
        if (req.file.size > 10*1024*1024) { // 10MB limit
            return res.status(400).json({ error: 'File size exceeds the 10MB limit' });
        }
        // Upload unprocessed file to S3
        const s3 = new AWS.S3();
        const fileName = `${Date.now()}-${req.file.originalname}`;
        const filePath = `${req.userSub}/original/${fileName}`;
        console.log(`Uploading file to s3://${process.env.S3_AUDIO_BUCKET}/${filePath}`);
        const s3Bucket = process.env.S3_AUDIO_BUCKET;
        await s3.upload({
            Bucket: s3Bucket,
            Key: filePath,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        }).promise();
        // Call Lambda function with S3 reference and user info for processing and inserting into postgres
        const lambda = new AWS.Lambda();
        const params = {
            FunctionName: process.env.AUDIO_PROCESSOR_LAMBDA,
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify({
                userSub: req.userSub,
                fileName: fileName,
                fileType: req.file.mimetype,
                username: req.username,
                s3Bucket: s3Bucket
            })
        };
        // console.log(params.Payload);
        const lambdaResponse = await lambda.invoke(params).promise();
        const responsePayload = JSON.parse(lambdaResponse.Payload);
        if (responsePayload.statusCode === 200) {
            // console.log('responsePayload.body: ', responsePayload.body);
            res.json({
                message: 'Conversion successful',
                metadata: responsePayload.body
            });
        } else {
            throw new Error(responsePayload.body || 'Audio conversion failed');
        }
    } catch (error) {
        console.error('Audio conversion error:', error);
        res.status(500).json({ error: 'Failed to convert audio file' });
    }
});


app.get('/get-audio/:trackId', verifyCognitoToken, async (req, res) => {
    // console.log('Getting audio...');
    const { trackId } = req.params;
    const userSub = req.userSub;
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: {
            rejectUnauthorized: false
        },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
    });
    const s3 = new AWS.S3();
    try {
        const client = await pool.connect();
        const result = await client.query(
            'SELECT s3_path, track_name FROM tracks WHERE track_id = $1 AND user_id = (SELECT user_id FROM users WHERE cognito_sub = $2)', 
            [trackId, userSub]
        );
        client.release();
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Track not found' });
        }
        const s3Key = result.rows[0].s3_path;
        const originalFilename = result.rows[0].track_name + '.mp3';
        const bucketName = process.env.S3_AUDIO_BUCKET
        const params = {
            Bucket: bucketName,
            Key: s3Key
        };
        // Get the file from S3
        const s3Object = await s3.getObject(params).promise();
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalFilename)}"`);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', s3Object.ContentLength);        
        // Send the file
        res.send(s3Object.Body);        
    } catch (error) {
        console.error('Error fetching track:', error);
        res.status(500).json({ error: 'Failed to download track' });
    } finally {
        await pool.end();
    }
});


// ---------------------- Audio Streaming ----------------------
app.get('/stream-tracks', verifyCognitoToken, async (req, res) => {
    const userSub = req.userSub;
    const range = req.headers.range;
    if (userSub === 'non_user') {
        return res.status(401).json({ error: 'Authentication required to stream audio' });
    }
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: {
            rejectUnauthorized: false
        },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
    }); 
    const s3 = new AWS.S3();
    try {
        const client = await pool.connect();
        const result = await client.query(
            `SELECT s3_path, track_name 
            FROM tracks 
            WHERE user_id = (SELECT user_id FROM users WHERE cognito_sub = $1 )
            ORDER BY RANDOM()
            LIMIT 1`,
            [userSub]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No tracks found in playlist' });
        }
        client.release();
        const s3Key = result.rows[0].s3_path;
        const bucketName = process.env.S3_AUDIO_BUCKET;
        // Get file metadata from S3
        const headParams = {
            Bucket: bucketName,
            Key: s3Key
        };
        const s3HeadObject = await s3.headObject(headParams).promise();
        const fileSize = s3HeadObject.ContentLength;
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = (end - start) + 1;
            const rangeParams = {
                Bucket: bucketName,
                Key: s3Key,
                Range: `bytes=${start}-${end}`
            };
            const s3Stream = s3.getObject(rangeParams).createReadStream();
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': 'audio/mpeg',
                'X-Track-Name': result.rows[0].track_name
            });
            s3Stream.pipe(res);
            s3Stream.on('error', (error) => {
                console.error('S3 stream error:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Error streaming audio file' });
                }
            });
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': 'audio/mpeg',
                'Accept-Ranges': 'bytes',
                'X-Track-Id': trackId,
                'X-Track-Name': result.rows[0].track_name
            });
            const s3Stream = s3.getObject(headParams).createReadStream();
            s3Stream.pipe(res);
            s3Stream.on('error', (error) => {
                console.error('S3 stream error:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Error streaming audio file' });
                }
            });
        }
    } catch (error) {
        console.error('Error fetching track:', error);
        res.status(500).json({ error: 'Failed to stream tracks' });
    } finally {
        await pool.end();
    }
});


app.get('/stream-playlist/:playlistId', verifyCognitoToken, async (req, res) => {
    const { playlistId } = req.params;
    const userSub = req.userSub;
    const range = req.headers.range;
    if (userSub === 'non_user') {
        return res.status(401).json({ error: 'Authentication required to stream audio' });
    }    
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: {
            rejectUnauthorized: false
        },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
    });
    const s3 = new AWS.S3();
    try {
        const playlistCheck = await pool.query(
            `SELECT 1 FROM playlists p
            JOIN users u ON p.user_id = u.user_id
            WHERE p.playlist_id = $1 AND u.cognito_sub = $2`,
            [playlistId, userSub]
        );
        if (playlistCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Playlist not found or access denied' });
        }
        // Get a random track from the playlist
        const randomTrackResult = await pool.query(
            `SELECT t.track_id
            FROM playlist_tracks pt
            JOIN tracks t ON pt.track_id = t.track_id
            JOIN users u ON t.user_id = u.user_id
            WHERE pt.playlist_id = $1 AND u.cognito_sub = $2
            ORDER BY RANDOM()
            LIMIT 1`,
            [playlistId, userSub]
        );
        if (randomTrackResult.rows.length === 0) {
            return res.status(404).json({ error: 'No tracks found in playlist' });
        }
        const trackId = randomTrackResult.rows[0].track_id;
        // Get track info from database
        const client = await pool.connect();
        const result = await client.query(
            'SELECT s3_path, track_name FROM tracks WHERE track_id = $1 AND user_id = (SELECT user_id FROM users WHERE cognito_sub = $2)', 
            [trackId, userSub]
        );
        client.release();
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Track not found' });
        }
        const s3Key = result.rows[0].s3_path;
        const bucketName = process.env.S3_AUDIO_BUCKET;
        // Get file metadata from S3
        const headParams = {
            Bucket: bucketName,
            Key: s3Key
        };
        const s3HeadObject = await s3.headObject(headParams).promise();
        const fileSize = s3HeadObject.ContentLength;
        // Handle range requests for audio streaming
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = (end - start) + 1;
            const rangeParams = {
                Bucket: bucketName,
                Key: s3Key,
                Range: `bytes=${start}-${end}`
            };
            const s3Stream = s3.getObject(rangeParams).createReadStream();
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': 'audio/mpeg',
                'X-Track-Id': trackId,
                'X-Track-Name': result.rows[0].track_name
            });
            s3Stream.pipe(res);
            s3Stream.on('error', (error) => {
                console.error('S3 stream error:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Error streaming audio file' });
                }
            });
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': 'audio/mpeg',
                'Accept-Ranges': 'bytes',
                'X-Track-Name': result.rows[0].track_name
            });
            const s3Stream = s3.getObject(headParams).createReadStream();
            s3Stream.pipe(res);
            s3Stream.on('error', (error) => {
                console.error('S3 stream error:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Error streaming audio file' });
                }
            });
        }
    } catch (error) {
        console.error('Error streaming playlist track:', error);
        res.status(500).json({ error: 'Failed to stream audio file from playlist' });
    } finally {
        await pool.end();
    }
});


// ---------------------- Music Library Management ----------------------
// gets
app.get('/user-tracks/:offset', verifyCognitoToken, async (req, res) => {
    const { offset } = req.params;
    const userSub = req.userSub;
    if (userSub === 'non_user') {
        return res.status(401).json({ error: 'Not logged in' });
    }
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: {
            rejectUnauthorized: false
        },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
    });
    try {
        const result = await pool.query(
            `SELECT t.* FROM tracks t
            JOIN users u ON t.user_id = u.user_id
            WHERE u.cognito_sub = $1
            ORDER BY t.track_name ASC
            LIMIT 25 OFFSET $2`,
            [userSub, offset]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching user tracks:', error);
        res.status(500).json({ error: 'Failed to fetch user tracks' });
    } finally {
        await pool.end();
    }
});


app.get('/playlist/:playlistId/:offset', verifyCognitoToken, async (req, res) => {
    const userSub = req.userSub;
    if (userSub === 'non_user') {
        return res.status(401).json({ error: 'Not logged in' });
    }
    const { playlistId } = req.params;
    if (!playlistId) {
        return res.status(400).json({ error: 'Playlist ID is required' });
    }
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: {
            rejectUnauthorized: false
        },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
    });
    try {
        // Check if playlist belongs to user
        const playlistCheck = await pool.query(
            `SELECT 1 FROM playlists p
            JOIN users u ON p.user_id = u.user_id
            WHERE p.playlist_id = $1 AND u.cognito_sub = $2`,
            [playlistId, userSub]
        );
        if (playlistCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Playlist not found or access denied' });
        }
        // get playlist tracks
        const result = await pool.query(
            `SELECT t.* 
            FROM playlist_tracks pt
            JOIN tracks t ON pt.track_id = t.track_id
            JOIN users u ON t.user_id = u.user_id
            WHERE pt.playlist_id = $1 AND u.cognito_sub = $2
            ORDER BY pt.position ASC`,
            [playlistId, userSub]
        );
        res.json({
            playlist: result.rows[0].playlist_id,
            tracks: result.rows
        });

    } catch (error) {
        console.error('Error fetching playlist:', error);
        res.status(500).json({ error: 'Failed to fetch playlist' });
    } finally {
        await pool.end();
    }
});


app.get('/user-playlists', verifyCognitoToken, async (req, res) => {
    const userSub = req.userSub;
    if (userSub === 'non_user') {
        return res.status(401).json({ error: 'Not logged in' });
    }
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: {
            rejectUnauthorized: false
        },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
    });
    try {
        const result = await pool.query(
            'SELECT * FROM user_playlists WHERE user_sub = $1',
            [userSub]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching user playlists:', error);
        res.status(500).json({ error: 'Failed to fetch user playlists' });
    } finally {
        await pool.end();
    }
});


// posts
app.post('/new-playlist', verifyCognitoToken, async (req, res) => {
    const userSub = req.userSub;
    if (userSub === 'non_user') {
        return res.status(401).json({ error: 'Not logged in' });
    }
    const { playlistName } = req.body;
    if (!playlistName) {
        return res.status(400).json({ error: 'Playlist name is required' });
    }
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: {
            rejectUnauthorized: false
        },
        connectionTimeoutMillis: 5000, 
        idleTimeoutMillis: 30000
    });
    try {
        const tmp = await pool.query(
            `SELECT 1 
            FROM playlists p
            JOIN users u 
            ON p.user_id = u.user_id
            WHERE u.cognito_sub = $1 
            AND p.playlist_name = $2`,
            [userSub, playlistName]
        );
        if (tmp.rows.length > 0) {
            return res.status(400).json({ error: 'Playlist already exists, try a different name' });
        }
        const result = await pool.query(
            `INSERT INTO playlists (user_id, playlist_name) 
            SELECT u.user_id, $2 
            FROM users u
            WHERE u.cognito_sub = $1
            RETURNING playlist_id, playlist_name`, 
            [userSub, playlistName]
        );
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error creating new playlist:', error);
        res.status(500).json({ error: 'Failed to create new playlist' });
    } finally {
        await pool.end();
    }
});


app.post('/add-to-playlist', verifyCognitoToken, async (req, res) => {
    const userSub = req.userSub;
    if (userSub === 'non_user') {
        return res.status(401).json({ error: 'Not logged in' });
    }
    const { trackIds, playlistId } = req.body;
    if (!trackIds || !playlistId || !Array.isArray(trackIds) || trackIds.length === 0) {
        return res.status(400).json({ error: 'Track IDs array and playlist ID are required' });
    }
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: {
            rejectUnauthorized: false
        },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
    });
    try {
        // Check if playlist belongs to user
        const playlistCheck = await pool.query(
            `SELECT 1 FROM playlists p
            JOIN users u ON p.user_id = u.user_id
            WHERE p.playlist_id = $1 AND u.cognito_sub = $2`,
            [playlistId, userSub]
        );
        if (playlistCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Playlist not found or access denied' });
        }
        // Verify all tracks belong to the user
        const tracksCheck = await pool.query(
            `SELECT COUNT(1) AS cnt
            FROM tracks t
            JOIN users u
            ON t.user_id = u.user_id
            WHERE track_id = ANY($1::int[]) 
            AND u.cognito_sub = $2`,
            [trackIds, userSub]
        );
        // console.log(tracksCheck.rows);
        // console.log(tracksCheck.rows[0].cnt);
        // console.log(trackIds.length);
        if (tracksCheck.rows[0].cnt != trackIds.length) {
            return res.status(403).json({ error: 'Some tracks do not belong to user' });
        }
        // Get current max position in playlist
        const maxPositionResult = await pool.query(
            `SELECT COALESCE(MAX(position), 0) as max_position 
            FROM playlist_tracks 
            WHERE playlist_id = $1`,
            [playlistId]
        );
        // Prepare batch insert with position increment
        const currentMaxPosition = maxPositionResult.rows[0].max_position;
        const placeholders = trackIds.map((_, i) => `($1, $${i*2 + 2}, $${i*2 + 3})`).join(',');
        try {
            const result = await pool.query(
                `INSERT INTO playlist_tracks (playlist_id, track_id, position)
                VALUES ${placeholders}
                ON CONFLICT DO NOTHING
                RETURNING playlist_id, track_id, position`,
                [playlistId, ...trackIds.flatMap((trackId, i) => [trackId, currentMaxPosition + i + 1])]
            );
            res.json({
                success: true,
                addedCount: result.rows.length,
                tracks: result.rows
            });
        } catch (error) {
            if (error.code === '23503') {
                return res.status(400).json({ error: 'One or more tracks do not exist' });
            }
            throw error;
        }
    } catch (error) {
        console.error('Error adding tracks to playlist:', error);
        res.status(500).json({ error: 'Failed to add tracks to playlist' });
    } finally {
        await pool.end();
    }
});


// deeletes
app.delete('/playlist/:playlistId', verifyCognitoToken, async (req, res) => {
    const userSub = req.userSub;
    if (userSub === 'non_user') {
        return res.status(401).json({ error: 'Not logged in' });
    }
    const { playlistId } = req.params;
    if (!playlistId) {
        return res.status(400).json({ error: 'Playlist ID is required' });
    }
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: {
            rejectUnauthorized: false
        },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
    });
    try {
        const playlistCheck = await pool.query(
            `SELECT 1 FROM playlists p
            JOIN users u ON p.user_id = u.user_id
            WHERE p.playlist_id = $1 AND u.cognito_sub = $2`,
            [playlistId, userSub]
        );
        if (playlistCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Playlist not found or access denied' });
        }
        await pool.query(
            'DELETE FROM playlist_tracks WHERE playlist_id = $1',
            [playlistId]
        );
        // Then delete the playlist itself
        const result = await pool.query(
            'DELETE FROM playlists WHERE playlist_id = $1 RETURNING playlist_id',
            [playlistId]
        );
        res.json({
            success: true,
            message: 'Playlist deleted successfully',
            deletedPlaylistId: result.rows[0].playlist_id
        });
    } catch (error) {
        console.error('Error deleting playlist:', error);
        res.status(500).json({ error: 'Failed to delete playlist' });
    } finally {
        await pool.end();
    }
});


app.delete('/playlist/:playlistId/tracks', verifyCognitoToken, async (req, res) => {
    const userSub = req.userSub;
    if (userSub === 'non_user') {
        return res.status(401).json({ error: 'Not logged in' });
    }
    const { playlistId } = req.params;
    const { trackIds } = req.body;
    if (!playlistId) {
        return res.status(400).json({ error: 'Playlist ID is required' });
    }
    if (!trackIds || !Array.isArray(trackIds) || trackIds.length === 0) {
        return res.status(400).json({ error: 'Track IDs array is required' });
    }
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: {
            rejectUnauthorized: false
        },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
    });
    try {
        const playlistCheck = await pool.query(
            `SELECT 1 FROM playlists p
            JOIN users u ON p.user_id = u.user_id
            WHERE p.playlist_id = $1 AND u.cognito_sub = $2`,
            [playlistId, userSub]
        );
        if (playlistCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Playlist not found or access denied' });
        }
        const result = await pool.query(
            `DELETE FROM playlist_tracks 
            WHERE playlist_id = $1 AND track_id = ANY($2::int[])
            RETURNING track_id`,
            [playlistId, trackIds]
        );
        res.json({
            success: true,
            message: 'Tracks removed from playlist',
            removedTracks: result.rows.map(row => row.track_id)
        });
    } catch (error) {
        console.error('Error removing tracks from playlist:', error);
        res.status(500).json({ error: 'Failed to remove tracks from playlist' });
    } finally {
        await pool.end();
    }
});


app.delete('/tracks', verifyCognitoToken, async (req, res) => {
    const userSub = req.userSub;
    if (userSub === 'non_user') {
        return res.status(401).json({ error: 'Not logged in' });
    }
    const { trackIds } = req.body;
    if (!trackIds || !Array.isArray(trackIds) || trackIds.length === 0) {
        return res.status(400).json({ error: 'Track IDs array is required' });
    }
    const pool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: {
            rejectUnauthorized: false
        },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
    });
    try {
        const tracksCheck = await pool.query(
            `SELECT COUNT(1) AS cnt
            FROM tracks t
            JOIN users u ON t.user_id = u.user_id
            WHERE track_id = ANY($1::int[]) 
            AND u.cognito_sub = $2`,
            [trackIds, userSub]
        );
        if (tracksCheck.rows[0].cnt != trackIds.length) {
            return res.status(403).json({ error: 'Some tracks do not belong to user' });
        }
        await pool.query(
            `DELETE FROM playlist_tracks
            WHERE track_id = ANY($1::int[])
            AND playlist_id IN (
                SELECT p.playlist_id
                FROM playlists p
                JOIN users u ON p.user_id = u.user_id
                WHERE u.cognito_sub = $2
            )`,
            [trackIds, userSub]
        );
        const result = await pool.query(
            `DELETE FROM tracks
            WHERE track_id = ANY($1::int[])
            AND user_id = (SELECT user_id FROM users WHERE cognito_sub = $2)
            RETURNING track_id, track_name`,
            [trackIds, userSub]
        );
        res.json({
            success: true,
            message: 'Tracks deleted successfully',
            deletedTracks: result.rows
        });
    } catch (error) {
        console.error('Error deleting tracks:', error);
        res.status(500).json({ error: 'Failed to delete tracks' });
    } finally {
        await pool.end();
    }
});