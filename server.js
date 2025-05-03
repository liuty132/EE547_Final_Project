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


// ---------------------- Home Page ----------------------
app.get('/', (req, res) => {
    res.sendFile('index.html', { root: './public' });
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
        res.json(data);
    } catch (error) {
        res.status(400).json({ error: error.message });
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
app.get('/stream', async (req, res) => {
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


// Route to serve the radio page
app.get('/radio', (req, res) => {
    // Read the radio.html file
    let radioHtml = fs.readFileSync(path.join(__dirname, 'public', 'radio.html'), 'utf8');
    // Inject the script tag before the closing body tag
    res.send(radioHtml);
});


// ---------------------- S3 & Lambda Integration ----------------------
// Middleware to verify Cognito token and extract user info
const verifyCognitoToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7, authHeader.length);
    }
    if (!token) {
        return res.status(401).json({ error: 'No valid token provided' });
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
        console.error('Token verification error:', error);
        res.status(401).json({ error: 'Invalid or expired token' });
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
        const fileName = `${req.userSub}/original/${Date.now()}-${req.file.originalname}`;
        const s3Bucket = process.env.S3_AUDIO_BUCKET;
        await s3.upload({
            Bucket: s3Bucket,
            Key: fileName,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
        }).promise();
        // Call Lambda function with S3 reference and user info for processing and inserting into postgres
        // const lambda = new AWS.Lambda();
        // const params = {
        //     FunctionName: process.env.AUDIO_PROCESSOR_LAMBDA,
        //     InvocationType: 'RequestResponse',
        //     Payload: JSON.stringify({
        //         fileName: fileName,
        //         fileType: req.file.mimetype,
        //         userSub: req.userSub,
        //         username: req.username,
        //         s3Bucket: s3Bucket
        //     })
        // };
        // const lambdaResponse = await lambda.invoke(params).promise();
        // const responsePayload = JSON.parse(lambdaResponse.Payload);
        // if (responsePayload.statusCode === 200) {
        //     res.json({
        //         message: 'File processed successfully',
        //         metadata: responsePayload.body
        //     });
        // } else {
        //     throw new Error(responsePayload.body || 'Lambda processing failed');
        // }
    } catch (error) {
        console.error('Audio processing error:', error);
        res.status(500).json({ error: 'Failed to process audio file' });
    }
});


// Route to serve the upload page
app.get('/upload', (req, res) => {
    // Read the upload.html file
    let uploadHtml = fs.readFileSync(path.join(__dirname, 'public', 'upload.html'), 'utf8');
    res.send(uploadHtml);
});