require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch').default;
const FormData = require('form-data');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

// Define a route for serving images
app.get('/images/:imageName', (req, res) => {
    const imageName = req.params.imageName;
    res.sendFile(path.join(__dirname, 'public/images', imageName));
});

// ComfyUI WebSocket setup
const ws = new WebSocket('ws://localhost:8188/ws');

ws.on('open', function open() {
    console.log('Connected to ComfyUI WebSocket');
});

ws.on('message', function incoming(data) {
    console.log('Received:', data);
    // Handle ComfyUI messages here
});

async function uploadImageToComfyUI(imagePath, maxRetries = 3, delay = 2000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const fileName = path.basename(imagePath);
            console.log(`[${attempt}] Attempting to upload image: ${fileName}`);

            // Check if file exists
            if (!fs.existsSync(imagePath)) {
                throw new Error(`File does not exist: ${imagePath}`);
            }

            const form = new FormData();
            form.append('image', fs.createReadStream(imagePath), {
                filename: fileName,
                contentType: 'image/png' // Adjust this based on your image type
            });

            console.log(`[${attempt}] Sending POST request to ComfyUI upload endpoint`);
            const uploadResponse = await fetch('http://localhost:8188/upload/image', {
                method: 'POST',
                body: form,
                timeout: 60000 // 60 seconds timeout
            });

            console.log(`[${attempt}] Received response from ComfyUI upload endpoint. Status: ${uploadResponse.status}`);

            if (!uploadResponse.ok) {
                const errorText = await uploadResponse.text();
                throw new Error(`Image upload failed: ${uploadResponse.status} ${errorText}`);
            }

            const uploadResult = await uploadResponse.json();
            console.log(`[${attempt}] Image upload successful. Result:`, uploadResult);

            return uploadResult.name || fileName;
        } catch (error) {
            console.error(`[ERROR] Attempt ${attempt} failed:`, error);
            if (attempt === maxRetries) {
                throw error;
            }
            console.log(`Retrying in ${delay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function processWithComfyUI(imagePath, fullName, gender, position, setPanggung, expression, bandGenre, selectedFrame) {
    try {
        console.log(`[1] Starting processWithComfyUI`);
        const uploadedImageName = await uploadImageToComfyUI(imagePath);
        console.log(`[2] Image uploaded successfully. Uploaded name: ${uploadedImageName}`);

        let uploadedFrame;
        if (selectedFrame) {
            const framePath = path.join(__dirname, 'public', 'images', `${selectedFrame}.png`);
            try {
                uploadedFrame = await uploadImageToComfyUI(framePath);
                console.log(`[3] Frame uploaded successfully. Uploaded name: ${uploadedFrame}`);
            } catch (frameUploadError) {
                console.error(`[ERROR] Failed to upload frame. Using default frame.`, frameUploadError);
                uploadedFrame = "sample_frame.png"; // Default frame if upload fails
            }
        } else {
            uploadedFrame = "sample_frame.png"; // Default frame if none selected
        }

        console.log(`[4] Reading workflow file`);
        const workflowRaw = fs.readFileSync(path.join(__dirname, 'workflow_api.json'), 'utf8');
        let workflow = JSON.parse(workflowRaw);

        console.log(`[5] Modifying workflow based on user input`);
        workflow["11"].inputs.image = uploadedImageName;
        workflow["29"].inputs.text_1 = `${gender} ${position} of a ${bandGenre} band`;
        workflow["29"].inputs.text_2 = `performing a concert with ${expression} expression`;
        workflow["29"].inputs.text_3 = `at a ${setPanggung}`;
        workflow["29"].inputs.text_6 = `${position} in foreground`;
        workflow["38"].inputs.image = uploadedFrame;

        const requestBody = {
            prompt: workflow,
            client_id: `test_${Date.now()}`
        };

        console.log(`[6] Sending workflow to ComfyUI`);
        const response = await fetch('http://localhost:8188/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        console.log(`[7] Received response from ComfyUI prompt endpoint. Status: ${response.status}`);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[ERROR] ComfyUI response not OK. Status: ${response.status}, Response: ${errorText}`);
            throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
        }

        const data = await response.json();
        console.log(`[8] ComfyUI prompt response:`, JSON.stringify(data, null, 2));

        // Wait for the image to be generated
        const promptId = data.prompt_id;
        const outputImageUrl = await waitForImageGeneration(promptId);
        console.log(`[9] Image generation complete. Output image URL:`, outputImageUrl);

        return outputImageUrl;
    } catch (error) {
        console.error(`[ERROR] Error in processWithComfyUI:`, error);
        throw error;
    }
}

async function waitForImageGeneration(promptId) {
    return new Promise((resolve, reject) => {
        const checkStatus = async () => {
            try {
                const historyResponse = await fetch(`http://localhost:8188/history/${promptId}`);
                const historyData = await historyResponse.json();

                if (historyData[promptId] && historyData[promptId].outputs && historyData[promptId].outputs["20"]) {
                    const outputImage = historyData[promptId].outputs["20"].images[0];
                    resolve(`http://localhost:8188/view?filename=${outputImage.filename}&subfolder=${outputImage.subfolder}&type=${outputImage.type}`);
                } else {
                    setTimeout(checkStatus, 1000); // Check again after 1 second
                }
            } catch (error) {
                reject(error);
            }
        };

        checkStatus();
    });
}

// Placeholder function for uploading to Google Drive (kept optional)
async function uploadToGoogleDrive(imagePath) {
    // ... (keep your existing Google Drive upload code)
}

// Form submission endpoint
app.post('/submit', upload.single('image'), async (req, res) => {
    const { fullName, email, gender, position, setPanggung, expression, bandGenre, selectedFrame } = req.body;
    const imagePath = req.file.path;

    console.log('Received form data:', { fullName, email, gender, position, setPanggung, expression, bandGenre, selectedFrame });

    try {
        // Process image with ComfyUI
        const generatedImageUrl = await processWithComfyUI(imagePath, fullName, gender, position, setPanggung, expression, bandGenre, selectedFrame);

        res.json({
            success: true,
            message: 'Portrait generated successfully!',
            imageUrl: generatedImageUrl
        });
    } catch (error) {
        console.error('[ERROR] Error in /submit endpoint:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred during image processing. Please try again.',
            error: error.message
        });
    } finally {
        // Clean up the uploaded file
        try {
            fs.unlinkSync(imagePath);
            console.log(`[CLEANUP] Removed temporary file: ${imagePath}`);
        } catch (unlinkError) {
            console.error(`[CLEANUP ERROR] Failed to remove temporary file: ${imagePath}`, unlinkError);
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));