-- Users 
CREATE TABLE IF NOT EXISTS users (
    user_id SERIAL PRIMARY KEY, 
    cognito_sub VARCHAR(255) NOT NULL,
    username VARCHAR(255) NOT NULL
);

-- Tracks 
CREATE TABLE IF NOT EXISTS tracks (
    track_id SERIAL PRIMARY KEY,
    track_name VARCHAR(255) NOT NULL,
    user_id INTEGER REFERENCES users(user_id),
    track_artist VARCHAR(255) NOT NULL,
    track_album VARCHAR(255) NOT NULL,
    duration_ms INTEGER NOT NULL,
    track_image_url VARCHAR(255),
    s3_path VARCHAR(255)
);

-- Playlists 
CREATE TABLE IF NOT EXISTS playlists (
    playlist_id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(user_id),
    playlist_name VARCHAR(255) NOT NULL
);

-- Junction table for playlist-track relationship
CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER REFERENCES playlists(playlist_id),
    track_id INTEGER REFERENCES tracks(track_id),
    position INTEGER, 
    PRIMARY KEY (playlist_id, track_id)
);


INSERT INTO users (cognito_sub, username)
VALUES
    ('e14b75a0-2041-70ab-d788-fe958b962d47', 'liuty132');