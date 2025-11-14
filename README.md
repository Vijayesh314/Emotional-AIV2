# Emotional-AI
This is a real-time voice emotion analysis that provides live feedback to help understand emotional states during conversations. Its powered by Google's Gemini 2.0 Flash AI and Firebase Authentication (made so that my official CAC submission doesn't have new commits after the submission).

## How it works
* Recording starts
* Every 30 seconds chunk is captured
* API analyzes it
* Updates UI with feedback
* Continue recording (loop)

## Features
* Real time voice analysis
* Gemini 2.0 Flash AI powered
* Live Vizualization
* Multiple emotions that can be detected
* Emotional timeline
* Firebase authentication
* Pitch, clarity, pace, energy tracking

## Emotions Categories
* happy 😊 - Joyful, cheerful, pleased
* sad 😢 - Unhappy, sorrowful, melancholy
* angry 😠 - Frustrated, irritated
* fearful 😨 - Afraid, anxious
* surprised 😲 - Shocked, amazed
* neutral 😐 - No strong emotion
* calm 😌 - Relaxed, peaceful
* confident 😎 - Assured, certain
* nervous 😰 - Tense, worried, uneasy
* excited 🤩 - Enthusiastic, energetic
* frustrated 😤 - Irritated, annoyed

## Voice categories
* Pitch: High, Medium, Low
* Pace: Fast, Moderate, Slow
* Energy: High, Moderate, Low
* Clarity: Excellent, Good, Fair, Poor

## Why it matters
* In tele-health and remote therapy settings, clinicians may not notice subtle anxiety, distress or disengagement when only voice is available, so this tool adds an extra layer of emotional awareness
* In business, sales, investor-calls or negotiations, presenters can monitor how their audience (or themselves) are feeling and adjust their tone, pacing or content accordingly
* In remote or hybrid interactions, where visual cues are limited, voice is the main means of communication, so tracking emotion via audio becomes especially valuable
* In education, teachers can detect how students are feeling during their lessons, and adapt their teaching style accordingly

## Tech Stack
* Backend: Python Flask for robust and manageable backend server along with Javascript for various functions
* Authentication: Firebase sign-in (email/password and/or google sigg-in)
* Emotion Detection: Emotion detected using a AI model, allowing us to analyze voice audio
* AI Model: The API key utilizes gemini's 2.0 flash as our core AI model to provide human-like feedback
* Frontend: The user interface was built using HTML/CSS and JSON for a responsive experience
* Audio Processor: Web Audio AI and MediaRecorder
* Data Format: 16kHz WAV audio
## Usage
* Make sure your browser allows microphone access with no interruptions or delays in the microphone
* Be close to the computer so that the microphone can properly hear and track your voice
