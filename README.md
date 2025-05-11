# Resona 432Hz Music Radio

## Repo Structure
```
.
├── server.js
├── table_creation.sql
├── .env
├── package.json
├── public/
│   ├── auth.js
│   ├── index.html
│   ├── radio.html
│   ├── radio.js
│   ├── upload.html
│   ├── upload.js
│   ├── dashboard.html
│   ├── dashboard.js
│   └── images/
└── lambda-deployment/
    ├── lambda_function.zip
    ├── lambda_layer.zip
    └── mp3_conversion.js
```

`server.js` is the backend server that handles API requests and serves the frontend. This is deployed to an AWS EC2 instance. 

`table_creation.sql` is the SQL schema used to create the Postgres database tables. 

`public/index.html`, `public/radio.html`, `public/upload.html`, `public/dashboard.html` are the frontend HTML files. They are the the homepage, radio page, conversion tool page, and music library page, respectively. 

`public/auth.js` is the frontend script that handles user authentication via AWS Cognito. 

`public/radio.js`, `public/upload.js`, `public/dashboard.js` are the frontend scripts that handle the frontend logic for each page. 

`lambda_layer.zip` is the custom Lambda layer that contains the lame binary required for MP3 conversion. 

`lambda_function.zip` is the Lambda function that converts user-uploaded MP3 files into 432Hz, and extracts the metadata. It is invoked from the server. 

`lambda-deployment/mp3_conversion.js` is the handler for the aforementioned Lambda function. 


## dotenv
```
AWS_REGION=
COGNITO_CLIENT_ID=
COGNITO_CLIENT_SECRET=
PORT=3000
S3_AUDIO_BUCKET=
AUDIO_PROCESSOR_LAMBDA=
DATABASE_URL=
DB_HOST=
DB_PORT=
DB_USER=
DB_PASSWORD=
DB_NAME=
S3_ACCESS_POINT_ARN=
```


## Setup for AWS Deployment 
1. AWS Cognito: create a user pool and client, and configure the user pool to allow email sign-in. 
2. AWS S3: create a bucket for storing user-uploaded MP3 files, allowing ACL uploads while blocking public access. Create an access point for the bucket. 
3. AWS RDS: create a Postgres database and configure the database. 
4. AWS Lambda: upload the Lambda function and layer. Add environment variables. 
5. AWS EC2: create an EC2 instance and deploy the server. 
6. Configure appropriate policies for all AWS services. 
7. SSH into EC2 instance, install dependencies, configure the environment variables and start the server: 
```
npm install
nano .env
node server.js
```