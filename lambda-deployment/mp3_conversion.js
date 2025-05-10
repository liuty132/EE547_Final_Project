const AWS = require('aws-sdk');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseFile } = require('music-metadata');
const NodeID3 = require('node-id3');
const lame = require('node-lame').Lame;
const wavEncoder = require('wav-encoder');
const wavDecoder = require('wav-decoder');

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
    // Pitch factor of 0.9818 lowers the pitch slightly (about a quarter step)
    const pitchFactor = 0.9818;
    const numChannels = audioBuffer.numberOfChannels;
    const bufferLength = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
    // Create a proper output buffer with actual Float32Arrays for each channel
    const channelData = [];
    for (let channel = 0; channel < numChannels; channel++) {
        channelData.push(new Float32Array(bufferLength));
    }
    const outputBuffer = {
        sampleRate: sampleRate,
        numberOfChannels: numChannels,
        length: bufferLength,
        duration: bufferLength / sampleRate,
        getChannelData: (channel) => channelData[channel]
    };
    // Process each channel
    for (let channel = 0; channel < numChannels; channel++) {
        const inputData = audioBuffer.getChannelData(channel);
        const outputData = outputBuffer.getChannelData(channel);
        // Process the entire buffer at once for better results
        for (let i = 0; i < bufferLength; i++) {
            // Calculate the exact sample position based on pitch factor
            const position = i * pitchFactor;
            const index = Math.floor(position);
            const fraction = position - index;
            // Bounds checking to avoid accessing outside the buffer
            if (index >= 0 && index < bufferLength - 1) {
                // Linear interpolation for simplicity and performance
                outputData[i] = inputData[index] * (1 - fraction) + inputData[index + 1] * fraction;
            } else if (index >= 0 && index < bufferLength) {
                // Edge case at the end of the buffer
                outputData[i] = inputData[index];
            }
            // Else leave as 0 (silence) for out-of-bounds indices
        }
    }
    return outputBuffer;
}


async function mp3ToAudioBuffer(mp3Buffer) {
    try {
        // Create temporary files for conversion
        const tempDir = os.tmpdir();
        const tempMp3Path = path.join(tempDir, `temp-${Date.now()}.mp3`);
        const tempWavPath = path.join(tempDir, `temp-${Date.now()}.wav`);
        // Write MP3 buffer to temp file
        fs.writeFileSync(tempMp3Path, mp3Buffer);
        // Convert MP3 to WAV using node-lame
        const decoder = new lame({
            output: tempWavPath,
            bitrate: 192
        });
        await decoder.setFile(tempMp3Path).decode();
        // Read WAV file
        const wavBuffer = fs.readFileSync(tempWavPath);
        // Decode WAV to audio buffer
        const wavData = await wavDecoder.decode(wavBuffer);
        // Create an AudioBuffer-like object
        const audioBuffer = {
            sampleRate: wavData.sampleRate,
            length: wavData.channelData[0].length,
            numberOfChannels: wavData.channelData.length,
            duration: wavData.channelData[0].length / wavData.sampleRate,
            getChannelData: (channel) => {
                if (channel < wavData.channelData.length) {
                    return wavData.channelData[channel];
                }
                return new Float32Array(wavData.channelData[0].length);
            }
        };
        // Clean up temp files
        try {
            fs.unlinkSync(tempMp3Path);
            fs.unlinkSync(tempWavPath);
        } catch (cleanupError) {
            console.warn('Error cleaning up temp files:', cleanupError);
        }
        
        return audioBuffer;
    } catch (error) {
        console.error('MP3 to AudioBuffer conversion error:', error);
        throw error;
    }
}

// Convert audio buffer to MP3 using pure JavaScript
async function audioBufferToMp3(audioBuffer) {
    // More robust implementation for Lambda environment
    try {
        // Extract audio data
        const numChannels = audioBuffer.numberOfChannels;
        const length = audioBuffer.length;
        const sampleRate = audioBuffer.sampleRate;
        // Prepare WAV data format
        const channelData = [];
        for (let channel = 0; channel < numChannels; channel++) {
            channelData.push(audioBuffer.getChannelData(channel));
        }
        // Create WAV data
        const wavData = {
            sampleRate: sampleRate,
            channelData: channelData
        };
        // Encode to WAV buffer
        const wavBuffer = await wavEncoder.encode(wavData);
        // Create temporary files for conversion
        const tempDir = os.tmpdir();
        const tempWavPath = path.join(tempDir, `temp-${Date.now()}.wav`);
        const tempMp3Path = path.join(tempDir, `temp-${Date.now()}.mp3`);
        // Write WAV buffer to temp file
        fs.writeFileSync(tempWavPath, Buffer.from(wavBuffer));
        // Convert WAV to MP3 using node-lame
        const encoder = new lame({
            output: tempMp3Path,
            bitrate: 192,
            mode: numChannels === 1 ? 'm' : 'j' // mono or joint stereo
        });
        await encoder.setFile(tempWavPath).encode();
        // Read MP3 file
        const mp3Buffer = fs.readFileSync(tempMp3Path);
        // Clean up temp files
        try {
            fs.unlinkSync(tempWavPath);
            fs.unlinkSync(tempMp3Path);
        } catch (cleanupError) {
            console.warn('Error cleaning up temp files:', cleanupError);
        }
        return mp3Buffer;
    } catch (error) {
        console.error('AudioBuffer to MP3 conversion error:', error);
        throw error;
    }
}


// Extract metadata from MP3 file
async function extractMetadata(filePath, userSub, filename, bucket) {
    try {
        // Read tags with node-id3
        const tags = NodeID3.read(filePath);
        let coverImageUrl = null;
        // Extract duration from music-metadata
        const metadata = await parseFile(filePath);
        const durationMs = metadata.format.duration ? Math.round(metadata.format.duration * 1000) : 0;
        // Upload cover image if exists
        if (tags.image && tags.image.imageBuffer) {
            const imageBuffer = tags.image.imageBuffer;
            const mimeType = tags.image.mime || 'image/jpeg';
            const extension = mimeType.split('/')[1] || 'jpg';
            const coverKey = `${userSub}/covers/${filename.replace(/\.[^/.]+$/, '')}.${extension}`;
            await s3.putObject({
                Bucket: bucket,
                Key: coverKey,
                Body: imageBuffer,
                ContentType: mimeType, 
                ACL: 'public-read'
            }).promise();
            coverImageUrl = `http://${process.env.BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${coverKey}`;
        }
        return {
            title: tags.title || 'Unknown Title',
            artist: tags.artist || 'Unknown Artist',
            album: tags.album || 'Unknown Album',
            year: tags.year || null,
            duration: durationMs, 
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

// Save metadata to DB
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
        console.log(`Downloading file from s3`);
        console.log(`${bucket}`);
        console.log(`${originalPath}`);
        const s3Object = await s3.getObject({ Bucket: bucket, Key: originalPath }).promise();
        fs.writeFileSync(localInputPath, s3Object.Body);
        // Extract metadata before processing
        console.log('Extracting metadata');
        const metadata = await extractMetadata(localInputPath, userSub, filename, bucket);
        // Convert MP3 to audio buffer
        console.log('Converting MP3 to audio buffer');
        const audioBuffer = await mp3ToAudioBuffer(s3Object.Body);
        // Process the audio using our pitch shifting algorithm
        console.log('Processing audio with pitch shifting algorithm');
        const processedBuffer = await applyPitchShifting(audioBuffer);
        // Convert processed audio buffer back to MP3
        console.log('Converting processed audio buffer to MP3');
        const processedMp3 = await audioBufferToMp3(processedBuffer);
        // Upload the processed file back to S3
        console.log(`Uploading processed file to s3://${bucket}/${filePath}`);
        await s3.putObject({
            Bucket: bucket,
            Key: filePath,
            Body: processedMp3, 
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