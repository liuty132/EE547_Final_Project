const AWS = require('aws-sdk');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseFile } = require('music-metadata/lib/core');


// Processing pipeline
// 1. Download from S3 under cognito-sub-id/original/XXX.mp3
// 2. MP3 → WAV → Audio Buffer → Process → Audio Buffer → WAV → MP3
// 3. Upload to S3 under cognito-sub-id/processed/XXX.mp3
// 4. Save metadata to PostgreSQL

// Initialize S3 and RDS
const s3 = new AWS.S3();
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: {
        rejectUnauthorized: false
    },
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000
});
const accessPointArn = process.env.S3_ACCESS_POINT_ARN;

// Pitch shifting algorithm
async function applyPitchShifting(audioBuffer) {
    const pitchFactor = 0.9818;
    const bufferSize = 4096;
    const numChannels = audioBuffer.numberOfChannels;
    const bufferLength = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
    const outputBuffer = {
        sampleRate: sampleRate,
        numberOfChannels: numChannels,
        length: bufferLength,
        duration: bufferLength / sampleRate,
        getChannelData: (channel) => new Float32Array(bufferLength)
    };
    for (let channel = 0; channel < numChannels; channel++) {
        const inputData = audioBuffer.getChannelData(channel);
        const outputData = outputBuffer.getChannelData(channel);
        // Process the audio in chunks
        for (let offset = 0; offset < bufferLength; offset += bufferSize) {
            const currentBufferSize = Math.min(bufferSize, bufferLength - offset);
            for (let i = 0; i < currentBufferSize; i++) {
                // Calculate the exact sample position based on pitch factor
                const position = i * pitchFactor;
                const index = Math.floor(position);
                const fraction = position - index;
                // Use cubic interpolation for higher quality result
                if (index > 0 && index < currentBufferSize - 2) {
                    // Four-point cubic interpolation for smoother results
                    const y0 = inputData[offset + index - 1];
                    const y1 = inputData[offset + index];
                    const y2 = inputData[offset + index + 1];
                    const y3 = inputData[offset + index + 2];
                    // Cubic interpolation formula
                    const c0 = y1;
                    const c1 = 0.5 * (y2 - y0);
                    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
                    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
                    outputData[offset + i] = ((c3 * fraction + c2) * fraction + c1) * fraction + c0;
                } else if (index < currentBufferSize - 1) {
                    // Fall back to linear interpolation at boundaries
                    outputData[offset + i] = inputData[offset + index] * (1 - fraction) + inputData[offset + index + 1] * fraction;
                } else {
                    // Edge case
                    outputData[offset + i] = inputData[offset + index];
                }
            }
        }
    }
    return outputBuffer;
}


// Convert MP3 to audio buffer using pure JavaScript
async function mp3ToAudioBuffer(mp3Buffer) {
    return;
}

// Convert audio buffer to MP3 using pure JavaScript
async function audioBufferToMp3(audioBuffer) {
    return;
}


// Extract metadata from MP3 file
async function extractMetadata(filePath, userSub, filename) {
    try {
        const metadata = await parseFile(filePath);
        let coverImageUrl = null;
        
        // Handle cover image if exists
        if (metadata.common.picture && metadata.common.picture.length > 0) {
            const picture = metadata.common.picture[0];
            const coverKey = `${userSub}/covers/${filename.replace(/\.[^/.]+$/, '')}.${picture.format.split('/')[1] || 'jpg'}`;
            await s3.putObject({
                Bucket: accessPointArn,
                Key: coverKey,
                Body: picture.data,
                ContentType: picture.format,
                ACL: 'public-read'
            }).promise();
            coverImageUrl = `https://${process.env.BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${coverKey}`;
        }

        return {
            title: metadata.common.title || 'Unknown Title',
            artist: metadata.common.artist || 'Unknown Artist',
            album: metadata.common.album || 'Unknown Album',
            year: metadata.common.year || null,
            duration: Math.round((metadata.format.duration || 0) * 1000), // convert to ms
            coverImageUrl: coverImageUrl
        };
    } catch (error) {
        console.error('Error extracting metadata:', error);
        return {
            title: 'Unknown Title',
            artist: 'Unknown Artist',
            album: 'Unknown Album',
            year: null,
            duration: 0,
            coverImageUrl: null
        };
    }
}

// Update the saveMetadataToDB function parameters
async function saveMetadataToDB(metadata, processedKey, userSub) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const query = `
            INSERT INTO tracks (
                track_name, user_id, track_artist, track_album, 
                duration_ms, track_image_url, s3_path
            )
            SELECT $1, u.user_id, $3, $4, $5, $6, $7
            FROM users u
            WHERE u.cognito_sub = $2
            RETURNING track_id
        `;
        const values = [
            metadata.title,
            userSub,
            metadata.artist,
            metadata.album,
            metadata.duration,
            metadata.coverImageUrl,
            processedKey
        ];
        const result = await client.query(query, values);
        await client.query('COMMIT');
        return result.rows[0].track_id;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}


exports.handler = async (event) => {
    let bucket, originalPath, userSub, filename;
    if (event.userSub && event.fileName && event.s3Bucket) {
        userSub = event.userSub;
        filename = event.fileName;
        bucket = event.s3Bucket;
        originalPath = `${userSub}/original/${filename}`;
    } else {
        console.error('Invalid event format:', event);
        return {
            statusCode: 400,
            body: JSON.stringify({ message: 'Invalid event format' })
        };
    }
    const filePath = `${userSub}/processed/${filename}`;
    const tempDir = os.tmpdir();
    const localInputPath = path.join(tempDir, filename);
    try {
        // Download the file from S3
        console.log(`Downloading file from s3://${bucket}/${originalPath}`);
        const s3Object = await s3.getObject({ Bucket: accessPointArn, Key: originalPath }).promise();
        fs.writeFileSync(localInputPath, s3Object.Body);
        // Extract metadata before processing
        console.log('Extracting metadata');
        const metadata = await extractMetadata(localInputPath, userSub, filename);
        // Convert MP3 to audio buffer
        // console.log('Converting MP3 to audio buffer');
        // const audioBuffer = await mp3ToAudioBuffer(s3Object.Body);
        // Process the audio using our pitch shifting algorithm
        // console.log('Processing audio with pitch shifting algorithm');
        // const processedBuffer = await applyPitchShifting(audioBuffer);
        // Convert processed audio buffer back to MP3
        // console.log('Converting processed audio buffer to MP3');
        // const processedMp3 = await audioBufferToMp3(processedBuffer);
        // Upload the processed file back to S3
        console.log(`Uploading processed file to s3://${bucket}/${filePath}`);
        await s3.putObject({
            Bucket: accessPointArn,
            Key: filePath,
            Body: s3Object.Body, // use the original MP3 content for now
            ContentType: 'audio/mpeg'
        }).promise();
        // Insert track metadata to pg
        console.log('Saving metadata to database');
        const fileId = await saveMetadataToDB(metadata, filePath, userSub);
        // Clean up
        fs.unlinkSync(localInputPath);
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Audio converted and saved to S3',
                fileId: fileId,
                originalKey: originalPath,
                processedKey: filePath
            })
        };
    } catch (error) {
        if (fs.existsSync(localInputPath)) fs.unlinkSync(localInputPath);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Error processing file', error: error.message })
        };
    }
};