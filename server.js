const express = require('express');
const bodyParser = require('body-parser');
const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');
// const multer = require('multer');
// const { Pool } = require('pg');
// const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const cookieParser = require('cookie-parser');
const path = require('path');
require('dotenv').config(); 

const app = express();
const port = process.env.PORT || 3000;
// const upload = multer({ storage: multer.memoryStorage() });

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


// ---------------------- Cognito ---------------------------
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
            secure: true, // for HTTPS
            sameSite: 'strict',
            maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
        });
        // Also store the username in a cookie for refresh token operations
        res.cookie('username', username, {
            httpOnly: true,
            secure: true,
            sameSite: 'strict',
            maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
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
        res.clearCookie('refreshToken', { httpOnly: true, secure: true, sameSite: 'strict' });
        res.clearCookie('username', { httpOnly: true, secure: true, sameSite: 'strict' });
        res.status(401).json({ error: 'Session expired or invalid. Please log in again.' }); 
    }
});


app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});





// ---------------------- S3 ---------------------------
// Might go with a Lambda function instead to handle MP3 file upload/conversion, metadata extraction, and database insertion. 


// const pool = new Pool({
//     user: 'postgres',
//     host: 'ee547-project-pg.cl8wooeqsgl3.us-east-2.rds.amazonaws.com',
//     database: 'ee547-project-pg',
//     password: 'tM2GFiFd9jRdRJt',
//     port: 5432,
// });

// const s3Client = new S3Client({ 
//     region: 'us-east-2',
//     credentials: {
//         accessKeyId: 'YOUR_ACCESS_KEY_ID',
//         secretAccessKey: 'YOUR_SECRET_ACCESS_KEY'
//     }
// });
// const S3_TRACK_BUCKET_NAME = 'your-bucket-name';


// // middleware to verify Cognito token and extract user info
// const verifyCognitoToken = async (req, res, next) => {
//     const authHeader = req.headers.authorization; // Get the full header
//     let token = null;
//     // Check if the header exists and starts with "Bearer "
//     if (authHeader && authHeader.startsWith('Bearer ')) {
//         // Extract the token part after "Bearer "
//         token = authHeader.substring(7, authHeader.length);
//     }

//     if (!token) { // Check if a token was successfully extracted
//         return res.status(401).json({ error: 'No valid token provided' });
//     }
//     try {
//         const params = {
//             AccessToken: token
//         };
//         const userData = await cognito.getUser(params).promise();
//         // Find the 'sub' attribute (user's unique ID in Cognito)
//         const subAttribute = userData.UserAttributes.find(attr => attr.Name === 'sub');
//         if (!subAttribute) {
//             // This shouldn't happen if getUser succeeds, but good to check
//             return res.status(401).json({ error: 'Could not identify user from token' });
//         }
//         req.userSub = subAttribute.Value; // Attach user sub to the request object
//         next(); // Proceed to the next middleware or route handler
//     } catch (error) {
//         console.error('Token verification error:', error); // Log the error server-side
//         res.status(401).json({ error: 'Invalid or expired token' }); // Send generic error
//     }
// };


// app.post('/upload', verifyCognitoToken, upload.single('audio'), async (req, res) => {
//     if (!req.file) {
//         return res.status(400).json({ error: 'No file uploaded' });
//     }
//     if (req.file.mimetype !== 'audio/mpeg') {
//         return res.status(400).json({ error: 'Only MP3 files are allowed' });
//     }
//     try {
//         // Upload to S3
//         const s3Key = `${Date.now()}-${req.file.originalname}`;
//         const s3Params = {
//             Bucket: S3_TRACK_BUCKET_NAME,
//             Key: s3Key,
//             Body: req.file.buffer,
//             ContentType: 'audio/mpeg'
//         };
//         await s3Client.send(new PutObjectCommand(s3Params));
//         // Store metadata in PostgreSQL
//         const query = 'INSERT INTO audio_files (user_sub, s3_key, filename) VALUES ($1, $2, $3) RETURNING *';
//         const values = [req.userSub, s3Key, req.file.originalname];
//         const result = await pool.query(query, values);
//         res.json({
//             message: 'File uploaded successfully',
//             fileData: result.rows[0]
//         });
//     } catch (error) {
//         console.error('Upload error:', error);
//         res.status(500).json({ error: 'Failed to upload file' });
//     }
// });




// Add this route to serve the HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


// Add this endpoint to get user info from the token
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
        // Find the username attribute
        const username = userData.Username;
        res.json({ username });
    } catch (error) {
        console.error('Get user info error:', error);
        res.status(401).json({ error: 'Invalid or expired token' });
    }
});