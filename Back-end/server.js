const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
// const axios = require("axios");
const WebSocket = require('ws');
const http = require('http');
const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const multer = require('multer');
// const translate = require('google-translate-api-x');

const clients = new Map(); // requestId -> ws
const canceledRequests = new Set(); // requestId values that have been canceled

// --- Constants ---
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIMETYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
];
// const DUCKDUCKGO_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";
// It's generally safer to load the model name directly from the environment or use a stable, well-documented default.
// 'models/gemini-2.0-flash' might not be a globally available fixed model name; 'gemini-1.5-flash-latest' is more common for flash.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-2.0-flash';

// --- Multer Configuration ---
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, Word (.doc/.docx), and images are allowed'));
    }
  }
});

// --- WebSocket Server ---
wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'register' && data.requestId) {
        clients.set(data.requestId, ws);
        console.log(`Client registered: ${data.requestId}`);
      } else if (data.type === 'cancel' && data.requestId) {
        canceledRequests.add(data.requestId);
        console.log(`Cancel requested: ${data.requestId}`);
        try {
          ws.send(JSON.stringify({ type: 'CANCELED-ACK', requestId: data.requestId }));
        } catch {}
      }
    } catch (e) {
      console.error('Invalid WebSocket message:', msg, e);
    }
  });

  ws.on('close', () => {
    for (const [id, clientWs] of clients.entries()) {
      if (clientWs === ws) {
        clients.delete(id);
        console.log(`Client unregistered: ${id}`);
        break;
      }
    }
  });
});

/**
 * Sends a progress update to a specific client via WebSocket.
 * @param {string} requestId - The ID of the client to send the message to.
 * @param {object} message - The message payload.
 */
function sendProgress(requestId, message) {
  const ws = clients.get(requestId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// --- DuckDuckGo Image Search Utilities ---
// /**
//  * Fetches the vqd parameter from DuckDuckGo's image search HTML.
//  * @param {string} query - The search query.
//  * @returns {Promise<string|null>} The vqd string or null if not found.
//  */
// async function getVQDFromHTML(query) {
//   const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
//   try {
//     const response = await axios.get(url, {
//       headers: {
//         'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
//         'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
//         'Accept-Encoding': 'gzip, deflate, br',
//         'Accept-Language': 'en-US,en;q=0.9',
//         'Connection': 'keep-alive'
//       }
//     });
//     const html = response.data;
//     // Extract vqd from the JavaScript variable in the HTML
//     const match = html.match(/vqd="([^"]+)"/);
//     return match ? match[1] : null;
//   } catch (error) {
//     console.error("Failed to get vqd:", error.message);
//     return null;
//   }
// }

// /**
//  * Checks if a given URL points to an image by making a HEAD request.
//  * @param {string} url - The URL to check.
//  * @returns {Promise<boolean>} True if the URL is an image, false otherwise.
//  */
// async function isImageUrl(url) {
//   try {
//     const response = await axios.head(url, {
//       validateStatus: () => true, // Don't throw on HTTP errors (e.g., 404, 500)
//       timeout: 2500 // Added a timeout for image HEAD requests
//     });
//     const contentType = response.headers['content-type'];
//     return contentType && contentType.startsWith('image/');
//   } catch (error) {
//     // console.warn(`Failed to validate image URL ${url}: ${error.message}`); // Keep this commented unless deep debugging
//     return false;
//   }
// }

// /**
//  * Retries a promise with a timeout.
//  * @param {Promise<any>} promise - The promise to execute.
//  * @param {number} ms - The timeout duration in milliseconds.
//  * @returns {Promise<any>} The resolved promise result or a timeout error.
//  */
// function retryIfTimeout(promise, ms) {
//   return new Promise((resolve, reject) => {
//     const timeoutId = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
//     promise
//       .then((res) => {
//         clearTimeout(timeoutId);
//         resolve(res);
//       })
//       .catch((err) => {
//         clearTimeout(timeoutId);
//         reject(err);
//       });
//   });
// }

/**
 * Retries a function until its result is valid or max retries are reached.
 * Includes exponential backoff for delays.
 * @param {Function} fn - The function to execute.
 * @param {Function} isValid - A function that validates the result of `fn`.
 * @param {number} [maxRetries=2] - The maximum number of retries.
 * @returns {Promise<any>} The valid result.
 */
const retryIfInvalid = async (fn, isValid, maxRetries = 4, shouldCancel = () => false) => {
  let result;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (shouldCancel && shouldCancel()) {
      throw new Error('Canceled');
    }
    result = await fn();
    if (isValid(result)) return result;
    // Exponential backoff
    await delay(Math.pow(2, attempt) * 1000); // 1s, 2s, 4s, ...
  }
  throw new Error(`Validation failed after ${maxRetries} retries.`);
};

// /**
//  * Fetches an image link from DuckDuckGo based on a query.
//  * Includes a robust vqd acquisition.
//  * @param {string} query - The search query.
//  * @returns {Promise<string|null>} The image URL or null if not found.
//  */
// async function getImageLink(query, url, headers) {
//   try {
//     const response = await axios.get(url, { headers, timeout: 10000 }); // Added timeout for the image search itself
//     const results = response.data.results;

//     for (const item of results) {
//       if (item.image && !item.image.includes("ytimg.com") && item.height <= (item.width * 2)) {
//         // Check if it's a valid image URL sequentially for robustness
//         if (await isImageUrl(item.image)) {
//           return item.image;
//         }
//       }
//     }
//     return null;
//   } catch (error) {
//     console.error(`Error fetching or checking images for query "${query}": ${error.message}`);
//     return null;
//   }
// }

// /**
//  * Attempts to get an image with multiple retries and a timeout for each attempt.
//  * Implements exponential backoff between retries.
//  * @param {string} query - The search query.
//  * @param {number} [retries=3] - Number of retries.
//  * @param {number} [timeoutMs=15000] - Timeout for each attempt in milliseconds.
//  * @returns {Promise<string|null>} The image URL or null.
//  */
// async function getImageWithRetry(query, language, retries = 3, timeoutMs = 10000) {
//   // Retry vqd acquisition if it fails or returns null
//   const vqd = await retryIfInvalid(
//     () => getVQDFromHTML(query),
//     (v) => v !== null,
//     3 // Max 3 retries for vqd acquisition
//   ).catch(err => {
//     console.warn(`Failed to get vqd for query "${query}" after retries: ${err.message}`);
//     return null;
//   });

//   if (!vqd) {
//     return null; // Cannot proceed without vqd
//   }

//   const url = `https://duckduckgo.com/i.js?o=json&q=${encodeURIComponent(query)}&l=us-en&vqd=${encodeURIComponent(vqd)}&p=1&f=size%3ALarge`;
//   const headers = {
//     'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
//     'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
//     'Accept-Encoding': 'gzip, deflate, br',
//     'Accept-Language': 'en-US,en;q=0.9',
//     'Connection': 'keep-alive'
//   };

//   for (let attempt = 0; attempt <= retries; attempt++) {
//     try {
//       let image;
//       const enQuery = await translate(query, { from: language, to: "en" }).then(res => {
//         return res.text;
//       });
//       if (attempt > 0) {
//         const vqd = await retryIfInvalid(
//           () => getVQDFromHTML(enQuery),
//           (v) => v !== null,
//           3 // Max 3 retries for vqd acquisition
//         ).catch(err => {
//           console.warn(`Failed to get vqd for query "${query}" after retries: ${err.message}`);
//           return null;
//         });
//         const url = `https://duckduckgo.com/i.js?o=json&q=${encodeURIComponent(enQuery)}&l=us-en&vqd=${encodeURIComponent(vqd)}&p=1&f=size%3ALarge`;
//         const headers = {
//           "User-Agent": DUCKDUCKGO_USER_AGENT, // CORRECTED TYPO HERE
//         };

//         image = await retryIfTimeout(getImageLink(enQuery, url, headers), timeoutMs);
//       } else {
//         image = await retryIfTimeout(getImageLink(query, url, headers), timeoutMs);
//       }
//       if (image) return image;
//     } catch (err) {
//       console.log(`Attempt ${attempt + 1}/${retries + 1} for "${query}": No image found or operation timed out. Error: ${err.message}.`);
//       if (attempt < retries) {
//         await delay(Math.pow(2, attempt) * 1000); // Exponential backoff: 1s, 2s, 4s...
//       }
//     }
//   }
//   console.warn(`❌ Failed to get image after ${retries + 1} attempts for query: "${query}"`);
//   return null;
// }

// --- Gemini setup ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL = GEMINI_MODEL;

// --- Utility ---
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrapper for Gemini API calls.
 * @param {string} prompt - The text prompt for Gemini.
 * @param {Array<object>} [files=[]] - Array of file objects with buffer and mimetype.
 * @returns {Promise<string>} The generated text response.
 */
async function generateGeminiResponse(prompt, files = []) {
  const model = genAI.getGenerativeModel({ model: MODEL });
  const parts = [
    { text: prompt },
    ...files.map(file => ({
      inlineData: {
        data: file.buffer.toString('base64'),
        mimeType: file.mimetype
      }
    }))
  ];
  const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
  return (await result.response).text();
}

/**
 * Summarizes provided files using Gemini.
 * @param {object} params
 * @param {Array<object>} params.files - Array of file objects.
 * @param {string} params.language - The desired language for the summary.
 * @returns {Promise<string|null>} The summarized content or null on error.
 */
async function getSummerizedFile({ files = [], language }) {
  let finalResult;
  // Joining file originalnames with a comma and space for better readability in the prompt
  const fileNames = files?.map(file => file.originalname).join(', ');
  const prompt = `
**Role:** You are a very detailed file summarizer.

**Task:** Summarize these files ${fileNames} very detailed without ignoring any of its content in "${language}" language.

**Output only the summary (NO Extra explanation)**
`;
  try {
    finalResult = await generateGeminiResponse(prompt, files);
  } catch (err) {
    console.warn(`❌ Error generating the file summary: ${err.message}`);
  }

  return finalResult || null;
}

// 🔸 STEP 1: Get Course Plan
async function getCoursePlan({ topic, level, time, language, sources }) {
  let finalResult;
  const sectionsCount = time <= 30 ? 4 : Math.floor(time / 10);
  const sourceInstruction = sources ? `**IMPORTANT:** The content strictly base on the provided content! Use it as sources only: ${sources}` : "";

  const prompt = `
**Role:** Course Structure Designer for a mobile learning app.

**Task:** Design a course on "${topic}" for a learner at level ${level}/10. The learner has ${time} minutes total and prefers to learn in "${language}" language.
${sourceInstruction}

**Course Structure Requirements:**
* **Sections:** ${sectionsCount} sections
* **Language Tone:**
    * Simple language for low levels.
    * Complex language for high levels.
* **Titles:** Course title and section titles must be in "${language}".
* **Flow:**
    * Start with an "Introduction" section.
    * Progress from easier to harder topics.
    * Avoid duplicated content.
    * Final section: "Summary" or "Review" of the course.
* **Time Allocation:** Smartly allocate available time across sections based on complexity.

**Each Section Must Include (JSON Fields):**
* \`"title"\`: A short, clear section title.
* \`"complexity"\`: 1 (easy) to 5 (hard).
* \`"availableTime"\`: Time allocated in minutes.
* \`"bulletCount"\`: Number of content blocks.
* \`"bulletTitles"\`: Titles of content blocks (array of strings).

**Output Format (Strict JSON Object Only):**
\`\`\`json
{
    "title": "a one word title which explains the topic ONLY",
    "sections": [
        {
            "title": "Section Title",
            "complexity": 1-5,
            "availableTime": minutes,
            "bulletCount": number,
            "bulletTitles": ["first bulletTitle", "second bulletTitle"]
        }
    ]
}
\`\`\`
`;
  try {
    const raw = await generateGeminiResponse(prompt);
    const json = raw.replace(/```json|```/g, '').trim();
    finalResult = JSON.parse(json);
  } catch (err) {
    console.warn(`❌ Error generating the course plan: ${err.message}`);
  }

  return finalResult || {
    error: 'Failed to generate valid JSON.',
    content: [],
    test: []
  };
}

// 🔸 STEP 2: Generate Section Content
async function generateSection({ section, level, language, topic, sources }) {
  const bulletCount = section.bulletCount || 3;
  let finalResult;
  const sourceInstruction = sources !== null ? `**IMPORTANT:** The content strictly base on the provided source! Use it as sources only: {${sources}}` : "";
  const bulletTitlesFormatted = Array.isArray(section.bulletTitles) ? section.bulletTitles.map(title => `"${title}"`).join(', ') : '';

  const prompt = `
**Role:** Mobile Course Content Generator.

**Task:** Create a course section for a level ${level}/10 learner.
${sourceInstruction}

**Section Details:**
* **Title:** "${section.title}"
* **Topic:** "${topic}"
* **Language:** "${language}"
* **Language Tone:**
    * Simple language for low levels.
    * Complex language for high levels.
**Content Generation Rules:**
* Generate **exactly ${bulletCount} content items**.
* Use the provided content titles: **${bulletTitlesFormatted}**.
* Each content item must include:
    * Its given title.
    * **2 to 4 short paragraphs** explaining the concept, provided as strings within a "bulletpoints" array.
* Use **clear, mobile-friendly language**.
* All content (titles, bulletpoints) must be in "${language}".

**Quiz Generation Rules:**
* Generate **exactly ${bulletCount} multiple-choice quiz questions**, one per content item.
* Each question must have **4 options**: 1 correct and 3 incorrect.
* All questions and answers must be in "${language}".

**Output Format (Strict JSON Object Only):**
${"```"}json
{
  "title": "Section Title",
  "content": [
    {
      "title": "The title given",
      "bulletpoints": ["Para1", "Para2", "..."]
    }
  ],
  "test": [
    {
      "question": "Question?",
      "answer": "Correct",
      "options": ["Correct", "Wrong", "Wrong", "Wrong"]
    }
  ]
}
`;
  try {
    const raw = await generateGeminiResponse(prompt);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

    const contentWithIds = await Promise.all(parsed.content.map(async (item, index) => {
      // const searchQuery = `${topic} ${item.title}`;
      // let imageUrl = await getImageWithRetry(searchQuery, language); // This now uses the more robust retry logic
      return {
        id: index,
        isDone: false,
        ...item,
        // image: imageUrl
      };
    }));

    const testWithIsDone = (parsed.test || []).map((item, index) => ({
      id: index,
      isDone: false,
      ...item
    }));

    finalResult = { ...section, ...parsed, content: contentWithIds, test: testWithIsDone };

  } catch (err) {
    console.warn(`❌ Error generating "${section.title}": ${err.message}`);
  }

  return finalResult || {
    ...section,
    error: 'Failed to generate valid JSON or content.',
    content: [],
    test: []
  };
}

// 🔸 STEP 3: Generate Full Course
app.post('/generate-course', upload.array('files', 3), async (req, res) => {
  const { topic, level, time, language, requestId } = req.body;
  const files = req.files || [];

  // Input validation
  if (!topic && !files || !level || !time || !language || !requestId) {
    const errorMessage = 'Missing required course generation parameters: topic, level, time, language, or requestId.';
    console.error(`Client Error: ${errorMessage}`);
    sendProgress(requestId, { type: 'ERROR', current: 0, total: 0, sectionTitle: errorMessage, error: true, done: false });
    return res.status(400).json({ error: errorMessage });
  }

  try {
    let sources = null;
    if (files.length > 0) {
      sendProgress(requestId, { type: 'PROCESSING', sectionTitle: 'Summarizing provided files...', current: 0, total: 0, error: false, done: false });
      sources = await retryIfInvalid(
        () => getSummerizedFile({ files, language }),
        (source) => source !== null,
        4,
        () => canceledRequests.has(requestId)
      );
      if (!sources) {
        throw new Error('Failed to summarize files after multiple attempts.');
      }
    }

    if (canceledRequests.has(requestId)) throw new Error('Canceled');
    sendProgress(requestId, { done: false, error: false, current: 0, total: 0, sectionTitle: "Generating Course Plan", type: "PLANING" });
    const coursePlan = await retryIfInvalid(
      () => getCoursePlan({ topic, level, time, language, sources }),
      // Adjusted validation for course plan sections based on calculated count
      (plan) => plan?.sections?.length >= (time <= 30 ? 4 : Math.floor(time / 10)) && plan?.sections !== undefined,
      4,
      () => canceledRequests.has(requestId)
    );

    const sectionsData = [];
    for (const [i, section] of coursePlan.sections.entries()) {
      if (canceledRequests.has(requestId)) throw new Error('Canceled');
      console.log(`🛠 Generating section ${i + 1}/${coursePlan.sections.length} — "${section.title}"`);
      sendProgress(requestId, {
        type: 'PROGRESS',
        current: i + 1,
        total: coursePlan.sections.length,
        sectionTitle: section.title,
        error: false,
        done: false
      });
      const generated = await retryIfInvalid(
        () => generateSection({ section, level, language, topic: coursePlan.title, sources }),
        (gen) => gen?.content?.length > 0,
        4,
        () => canceledRequests.has(requestId)
      );
      sectionsData.push(generated);
    }

    if (canceledRequests.has(requestId)) throw new Error('Canceled');
    sendProgress(requestId, { done: true, error: false, current: coursePlan.sections.length, total: coursePlan.sections.length, sectionTitle: "Generating Course Plan", type: "DONE" });

    res.json({
      topic: coursePlan.title,
      level,
      language,
      sections: sectionsData
    });

  } catch (error) {
    const msg = error && error.message ? error.message : String(error);
    console.error('Error during course generation:', msg);
    if (msg === 'Canceled' || canceledRequests.has(requestId)) {
      sendProgress(requestId, {
        type: 'CANCELED',
        current: 0,
        total: 0,
        sectionTitle: 'Canceled by user',
        error: true,
        done: false
      });
      res.status(499).json({ error: 'Canceled by user' });
    } else {
      sendProgress(requestId, {
        type: 'ERROR',
        current: 0,
        total: 0,
        sectionTitle: msg,
        error: true,
        done: false
      });
      res.status(500).json({ error: msg });
    }
  } finally {
    // Cleanup cancellation flag for this request
    if (requestId) canceledRequests.delete(requestId);
  }
});

app.post('/regenerate-lesson', async (req, res) => {
  const { language, level, bulletpoints } = req.body;

  if (!language || !level || !Array.isArray(bulletpoints) || bulletpoints.length === 0) {
    return res.status(400).json({ error: 'Missing required fields: language, level, or bulletpoints must be a non-empty array.' });
  }

  const prompt = `
**Role:** Educational Mobile Content Rewriting Engine.

**Task:** Rewrite the following bulletpoints.

**Instructions:**
* Rewrite the provided bulletpoints in **${language}** for a learner at **level ${level}/10**.
* **Crucially, maintain the original meaning and all information.**
* Ensure the rewritten content uses **mobile-friendly, clear language**.

**Input Bulletpoints (JSON array of strings):**
\`\`\`json
${JSON.stringify(bulletpoints, null, 2)}
\`\`\`
`;

  try {
    const raw = await generateGeminiResponse(prompt);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

    // Basic validation for the regenerated content
    if (!Array.isArray(parsed)) {
      throw new Error("Regenerated content is not a valid JSON array.");
    }
    res.json({ newBulletpoints: parsed });
  } catch (err) {
    console.error('❌ Error during regeneration:', err.message);
    res.status(500).json({ error: 'Failed to regenerate bulletpoints.' });
  }
});


// Start server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));