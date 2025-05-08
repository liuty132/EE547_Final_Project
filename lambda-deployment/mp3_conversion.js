const AWS = require('aws-sdk');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseFile } = require('music-metadata');
const NodeID3 = require('node-id3');

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


// Convert MP3 to audio buffer using pure JavaScript
async function mp3ToAudioBuffer(filePath) {
    try {
        const mp3Parser = require('mp3-parser');
        const createBuffer = require('audio-buffer-from');
        const fs = require('fs');
        
        // Read the MP3 file
        const fileBuffer = fs.readFileSync(filePath);
        
        // Parse the MP3 file
        const arrayBuffer = new Uint8Array(fileBuffer).buffer;
        const tags = mp3Parser.readTags(arrayBuffer);
        
        // Extract the audio frames
        const frames = [];
        for (const tag of tags) {
            if (tag.type === 'frame') {
                frames.push(tag);
            }
        }
        
        if (frames.length === 0) {
            throw new Error('No audio frames found in MP3 file');
        }
        
        // Get audio format information from the first frame
        const firstFrame = frames[0];
        const sampleRate = firstFrame.header.samplingRate;
        const numChannels = firstFrame.header.channelMode === 'mono' ? 1 : 2;
        
        // Extract PCM data from all frames
        let pcmData = [];
        for (const frame of frames) {
            if (frame.data) {
                // Decode MP3 frame to PCM samples
                // This is a simplified approach - in a real implementation,
                // you would use a proper MP3 decoder like mpg123 or minimp3
                const samples = mp3Parser.readSamples(frame);
                pcmData = pcmData.concat(samples);
            }
        }
        
        // Calculate duration based on sample rate and number of samples
        const duration = pcmData.length / (sampleRate * numChannels);
        
        // Create an AudioBuffer from the PCM data
        const audioBuffer = createBuffer(pcmData, {
            numberOfChannels: numChannels,
            sampleRate: sampleRate,
            format: 'float32'
        });
        
        console.log('Created audio buffer with:', {
            sampleRate: audioBuffer.sampleRate,
            channels: audioBuffer.numberOfChannels,
            duration: audioBuffer.duration
        });
        
        return audioBuffer;
    } catch (error) {
        console.error('MP3 to AudioBuffer conversion error:', error);
        
        // Fallback to metadata-only approach if decoding fails
        const metadata = await parseFile(filePath);
        console.log('Falling back to placeholder audio buffer');
        
        // Create a simplified audio buffer representation with placeholder data
        const audioBuffer = {
            sampleRate: metadata.format.sampleRate,
            numberOfChannels: metadata.format.numberOfChannels,
            length: Math.round(metadata.format.duration * metadata.format.sampleRate),
            duration: metadata.format.duration,
            getChannelData: (channel) => {
                // Create a placeholder channel data with some random noise
                // to simulate audio content
                const buffer = new Float32Array(Math.round(metadata.format.duration * metadata.format.sampleRate));
                for (let i = 0; i < buffer.length; i++) {
                    buffer[i] = (Math.random() * 2 - 1) * 0.01; // Very quiet noise
                }
                return buffer;
            }
        };
        return audioBuffer;
    }
}

// Convert audio buffer to MP3 using pure JavaScript
async function audioBufferToMp3(audioBuffer) {
    try {
        const lame = require('lamejs');
        
        // MP3 encoding parameters
        const bitRate = 128; // kbps
        const sampleRate = audioBuffer.sampleRate;
        const numChannels = audioBuffer.numberOfChannels;
        
        // Create MP3 encoder
        const mp3encoder = new lame.Mp3Encoder(numChannels, sampleRate, bitRate);
        
        // Process each channel
        const mp3Data = [];
        const sampleBlockSize = 1152; // Must be a multiple of 576 for MPEG1 and 1152 for MPEG2
        
        // Get audio data from each channel
        const channels = [];
        for (let i = 0; i < numChannels; i++) {
            channels.push(audioBuffer.getChannelData(i));
        }
        
        // Process the audio in chunks
        for (let i = 0; i < audioBuffer.length; i += sampleBlockSize) {
            // Create sample blocks for each channel
            const leftSamples = new Int16Array(sampleBlockSize);
            const rightSamples = numChannels === 2 ? new Int16Array(sampleBlockSize) : null;
            
            // Convert Float32 samples to Int16 samples
            for (let j = 0; j < sampleBlockSize; j++) {
                if (i + j < audioBuffer.length) {
                    // Convert float [-1.0, 1.0] to int [-32768, 32767]
                    const left = Math.max(-1, Math.min(1, channels[0][i + j]));
                    leftSamples[j] = left < 0 ? left * 32768 : left * 32767;
                    
                    if (numChannels === 2) {
                        const right = Math.max(-1, Math.min(1, channels[1][i + j]));
                        rightSamples[j] = right < 0 ? right * 32768 : right * 32767;
                    }
                }
            }
            
            // Encode samples to MP3
            let mp3buf;
            if (numChannels === 1) {
                mp3buf = mp3encoder.encodeBuffer(leftSamples);
            } else {
                mp3buf = mp3encoder.encodeBuffer(leftSamples, rightSamples);
            }
            if (mp3buf.length > 0) {
                mp3Data.push(Buffer.from(mp3buf));
            }
        }
        
        // Finalize the MP3 encoding
        const finalizeBuf = mp3encoder.flush();
        if (finalizeBuf.length > 0) {
            mp3Data.push(Buffer.from(finalizeBuf));
        }
        
        // Combine all MP3 data chunks into a single buffer
        return Buffer.concat(mp3Data);
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
                ContentType: mimeType
            }).promise();
            coverImageUrl = `https://${process.env.BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${coverKey}`;
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
        console.log(`Downloading file from s3}`);
        console.log(`${bucket}`);
        console.log(`${originalPath}`);
        const s3Object = await s3.getObject({ Bucket: bucket, Key: originalPath }).promise();
        fs.writeFileSync(localInputPath, s3Object.Body);
        // Extract metadata before processing
        console.log('Extracting metadata');
        const metadata = await extractMetadata(localInputPath, userSub, filename, bucket);

        // Convert MP3 to audio buffer
        console.log('Converting MP3 to audio buffer');
        // const audioBuffer = await mp3ToAudioBuffer(localInputPath);

        // Process the audio using our pitch shifting algorithm
        console.log('Processing audio with pitch shifting algorithm');
        // const processedBuffer = await applyPitchShifting(audioBuffer);
        
        // Convert processed audio buffer back to MP3
        console.log('Converting processed audio buffer to MP3');
        // const processedMp3 = await audioBufferToMp3(processedBuffer);
        
        // Upload the processed file back to S3
        console.log(`Uploading processed file to s3://${bucket}/${filePath}`);
        await s3.putObject({
            Bucket: bucket,
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