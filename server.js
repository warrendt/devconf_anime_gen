// Load environment variables from .env file in non-production environments
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
} else {
  console.log('Running in production mode - environment variables should be set in App Service Configuration');
}

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { DefaultAzureCredential } = require('@azure/identity');
const { BlobServiceClient } = require('@azure/storage-blob');
const { OpenAIClient } = require('@azure/openai');
const QRCode = require('qrcode');
const sharp = require('sharp');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create temp directory if it doesn't exist
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Determine if we're in local testing mode
const isLocalTesting = process.env.LOCAL_TESTING === 'true';
console.log(`Running in ${isLocalTesting ? 'LOCAL TESTING' : 'AZURE SERVICES'} mode`);

// Azure Storage setup - only if not in local testing mode
let credential, blobServiceClient, containerClient, openAIClient;

if (!isLocalTesting) {
  try {
    credential = new DefaultAzureCredential();
    
    if (process.env.STORAGE_ACCOUNT_NAME) {
      blobServiceClient = new BlobServiceClient(
        `https://${process.env.STORAGE_ACCOUNT_NAME}.blob.core.windows.net`,
        credential
      );
      containerClient = blobServiceClient.getContainerClient(process.env.CONTAINER_NAME || 'anime-images');
      console.log('Azure Blob Storage connected');
    } else {
      console.log('STORAGE_ACCOUNT_NAME not provided, Azure Blob Storage will not be used');
    }
    
    if (process.env.OPENAI_ENDPOINT) {
      openAIClient = new OpenAIClient(
        process.env.OPENAI_ENDPOINT,
        credential
      );
      console.log('Azure OpenAI connected');
    } else {
      console.log('OPENAI_ENDPOINT not provided, Azure OpenAI will not be used');
    }
  } catch (error) {
    console.error('Error setting up Azure services:', error);
    console.log('Falling back to local testing mode');
  }
} else {
  console.log('Running in local testing mode - Azure services will be simulated');
}

// Determine if we're in local testing mode
const isLocalTesting = process.env.LOCAL_TESTING === 'true';

// Azure Storage setup - only if not in local testing mode
let credential, blobServiceClient, containerClient, openAIClient;

if (!isLocalTesting) {
  credential = new DefaultAzureCredential();
  blobServiceClient = process.env.STORAGE_ACCOUNT_NAME 
    ? new BlobServiceClient(
        `https://${process.env.STORAGE_ACCOUNT_NAME}.blob.core.windows.net`,
        credential
      )
    : null;
  containerClient = blobServiceClient?.getContainerClient(process.env.CONTAINER_NAME || 'anime-images');

  // Azure OpenAI setup
  openAIClient = process.env.OPENAI_ENDPOINT 
    ? new OpenAIClient(
        process.env.OPENAI_ENDPOINT,
        credential
      )
    : null;
} else {
  console.log('Running in local testing mode - Azure services will be simulated');
}

// Configure multer for temporary file storage
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Helper function to generate anime image using Azure OpenAI with DALL-E
async function generateAnimeImage(imageBuffer) {
  try {
    // Resize image to acceptable size (1024x1024 max)
    const resizedImage = await sharp(imageBuffer)
      .resize({ width: 1024, height: 1024, fit: 'inside' })
      .toBuffer();
    
    // If in local testing mode, simulate anime conversion with a simple effect
    if (isLocalTesting) {
      console.log('Local testing mode: Applying simple image effects instead of using OpenAI');
      
      // Apply some effects to simulate anime-style conversion
      // In real application, this would be replaced by actual AI processing
      const simulatedAnimeImage = await sharp(resizedImage)
        .modulate({ brightness: 1.1, saturation: 1.5 })  // Increase brightness and saturation
        .sharpen({ sigma: 2 })  // Sharpen edges
        .toBuffer();
      
      return simulatedAnimeImage;
    }
    
    // For actual OpenAI processing
    if (!openAIClient) {
      throw new Error('OpenAI client not configured but LOCAL_TESTING is not enabled');
    }
    
    // Convert image to base64
    const base64Image = resizedImage.toString('base64');
    
    // Call OpenAI API to generate anime version
    const result = await openAIClient.getImages({
      deploymentName: process.env.OPENAI_DEPLOYMENT_NAME,
      prompt: "Convert this photo to high-quality anime style art, keep the same pose and appearance",
      n: 1,
      size: "1024x1024",
      user: "anime-generator-app",
      image: { base64Image }
    });
    
    if (result.data && result.data.length > 0) {
      // Download the generated image
      const response = await fetch(result.data[0].url);
      const imageBuffer = await response.arrayBuffer();
      return Buffer.from(imageBuffer);
    } else {
      throw new Error('No image was generated');
    }
  } catch (error) {
    console.error('Error generating anime image:', error);
    throw error;
  }
}

// Helper function to add QR code to image
async function addQRCodeToImage(imageBuffer, qrCodeContent) {
  try {
    // Generate QR code
    const qrCodeDataUrl = await QRCode.toDataURL(qrCodeContent, {
      errorCorrectionLevel: 'H',
      margin: 1,
      width: 200,
      color: {
        dark: '#000',
        light: '#FFF'
      }
    });
    
    // Convert QR code data URL to buffer
    const qrCodeData = qrCodeDataUrl.split(',')[1];
    const qrCodeBuffer = Buffer.from(qrCodeData, 'base64');
    
    // Get image dimensions
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;
    
    // Resize QR code to be proportional to the image size
    const qrSize = Math.min(width, height) * 0.2; // QR code size is 20% of the smallest dimension
    const qrCodeResized = await sharp(qrCodeBuffer)
      .resize(Math.round(qrSize), Math.round(qrSize))
      .toBuffer();
    
    // Composite images together
    const resultImage = await sharp(imageBuffer)
      .composite([{
        input: qrCodeResized,
        gravity: 'southeast', // Position in bottom right
      }])
      .toBuffer();
    
    return resultImage;
  } catch (error) {
    console.error('Error adding QR code to image:', error);
    throw error;
  }
}

// Upload image route
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Generate a unique ID for this image processing
    const imageId = uuidv4();
    
    // Process image to anime style
    const animeImage = await generateAnimeImage(req.file.buffer);
    
    // Generate a URL for the final image
    let finalImageUrl;
    let qrCodeContent;
    
    if (!isLocalTesting && blobServiceClient) {
      // In production, upload to Azure Blob Storage
      // Upload the original image to blob storage
      const blobName = `${imageId}-original.jpg`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadData(req.file.buffer);
      
      // Add URL to QR code
      qrCodeContent = blockBlobClient.url;
      
      // Add QR code to the anime image
      const finalImage = await addQRCodeToImage(animeImage, qrCodeContent);
      
      // Upload the final image to blob storage
      const finalBlobName = `${imageId}-final.jpg`;
      const finalBlockBlobClient = containerClient.getBlockBlobClient(finalBlobName);
      await finalBlockBlobClient.uploadData(finalImage);
      
      // Get URL for the final image
      finalImageUrl = finalBlockBlobClient.url;
    } else {
      // In local testing mode, save to local file system
      // Save original image
      const originalPath = path.join(tempDir, `${imageId}-original.jpg`);
      fs.writeFileSync(originalPath, req.file.buffer);
      
      // For local development, use a local URL
      qrCodeContent = `http://localhost:${port}/temp/${imageId}-original.jpg`;
      
      // Add QR code to the anime image
      const finalImage = await addQRCodeToImage(animeImage, qrCodeContent);
      
      // Save final image
      const finalPath = path.join(tempDir, `${imageId}-final.jpg`);
      fs.writeFileSync(finalPath, finalImage);
      
      // Set local URL
      finalImageUrl = `http://localhost:${port}/temp/${imageId}-final.jpg`;
    }
      
      // Add QR code to the anime image
      const finalImage = await addQRCodeToImage(animeImage, qrCodeContent);
      
      // Upload the final image to blob storage
      const finalBlobName = `${imageId}-final.jpg`;
      const finalBlockBlobClient = containerClient.getBlockBlobClient(finalBlobName);
      await finalBlockBlobClient.uploadData(finalImage);
      
      // Get URL for the final image
      finalImageUrl = finalBlockBlobClient.url;
    } else {
      // In development, save to local file system
      const tempDir = path.join(__dirname, 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
      }
      
      // Save original image
      const originalPath = path.join(tempDir, `${imageId}-original.jpg`);
      fs.writeFileSync(originalPath, req.file.buffer);
      
      // For local development, use a local URL
      const qrCodeContent = `http://localhost:${port}/temp/${imageId}-original.jpg`;
      
      // Add QR code to the anime image
      const finalImage = await addQRCodeToImage(animeImage, qrCodeContent);
      
      // Save final image
      const finalPath = path.join(tempDir, `${imageId}-final.jpg`);
      fs.writeFileSync(finalPath, finalImage);
      
      // Set local URL
      finalImageUrl = `http://localhost:${port}/temp/${imageId}-final.jpg`;
    }
    
    // Return url for the processed image
    res.json({
      success: true,
      imageUrl: finalImageUrl
    });
    
  } catch (error) {
    console.error('Error processing image:', error);
    res.status(500).json({ error: 'Error processing image', details: error.message });
  }
});

// Create a temporary route to serve images from the temp directory during development
app.use('/temp', express.static(path.join(__dirname, 'temp')));

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Running in ${process.env.NODE_ENV || 'development'} mode`);
});