// Global variables
let mediaRecorder
let audioContext
let analyser
let dataArray
let animationId
let isRecording = false
let recordingStartTime
let sessionId
let analysisQueue = []
let isAnalyzing = false
const emotionHistory = []

// Configuration
const CHUNK_DURATION = 30000 // 30 seconds - gives Hume time to process
const MIN_CHUNK_SIZE = 10000 // Larger chunks
const MAX_CONCURRENT_ANALYSIS = 1

// DOM elements
const startBtn = document.getElementById("startBtn")
const stopBtn = document.getElementById("stopBtn")
const statusIndicator = document.getElementById("status-indicator")
const recordingStatus = document.getElementById("recording-status")
const resultsSection = document.getElementById("results-section")
const canvas = document.getElementById("waveform")
const canvasCtx = canvas.getContext("2d")

// Check API status on load
async function checkStatus() {
  try {
    const response = await fetch("/api/check-status")
    const data = await response.json()

    if (data.configured) {
      statusIndicator.classList.add("ready")
      statusIndicator.querySelector(".status-text").textContent = "System Ready"
    } else {
      statusIndicator.classList.add("error")
      statusIndicator.querySelector(".status-text").textContent = "API Key Missing"
      startBtn.disabled = true
    }
  } catch (error) {
    console.error("Status check failed:", error)
    statusIndicator.classList.add("error")
    statusIndicator.querySelector(".status-text").textContent = "Connection Error"
    startBtn.disabled = true
  }
}

// Initialize audio visualization
function setupCanvas() {
  canvas.width = canvas.offsetWidth
  canvas.height = canvas.offsetHeight
}

// Draw waveform
function drawWaveform() {
  if (!isRecording) return

  animationId = requestAnimationFrame(drawWaveform)

  analyser.getByteTimeDomainData(dataArray)

  canvasCtx.fillStyle = "rgba(26, 32, 44, 0.5)"
  canvasCtx.fillRect(0, 0, canvas.width, canvas.height)

  canvasCtx.lineWidth = 2
  canvasCtx.strokeStyle = "#667eea"
  canvasCtx.beginPath()

  const sliceWidth = canvas.width / dataArray.length
  let x = 0

  for (let i = 0; i < dataArray.length; i++) {
    const v = dataArray[i] / 128.0
    const y = (v * canvas.height) / 2

    if (i === 0) {
      canvasCtx.moveTo(x, y)
    } else {
      canvasCtx.lineTo(x, y)
    }

    x += sliceWidth
  }

  canvasCtx.lineTo(canvas.width, canvas.height / 2)
  canvasCtx.stroke()
}

// Process audio chunk
async function processAudioChunk(audioBlob) {
  // Add to queue
  analysisQueue.push(audioBlob)
  
  // Process queue if not already processing
  if (!isAnalyzing) {
    processQueue()
  }
}

// Process analysis queue
async function processQueue() {
  if (analysisQueue.length === 0) {
    isAnalyzing = false
    return
  }
  
  isAnalyzing = true
  const audioBlob = analysisQueue.shift()
  
  // Skip if blob is too small
  if (audioBlob.size < MIN_CHUNK_SIZE) {
    console.log(`Skipping small chunk (${audioBlob.size} bytes)`)
    setTimeout(() => processQueue(), 100)
    return
  }
  
  try {
    // Convert blob to base64
    const reader = new FileReader()
    
    reader.onloadend = async () => {
      try {
        const base64Audio = reader.result
        
        // Show analyzing indicator
        updateStatusText("Analyzing...")
        
        const startTime = Date.now()
        
        const response = await fetch("/api/analyze-chunk", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ 
            audio: base64Audio,
            session_id: sessionId
          }),
        })

        const processingTime = ((Date.now() - startTime) / 1000).toFixed(1)

        if (response.ok) {
          const result = await response.json()
          
          updateUI(result)
          updateStatusText(`Recording... (${result.emotion} detected in ${processingTime}s)`)
          
          console.log(`Analysis completed in ${processingTime}s`)
        } else {
          const errorData = await response.json()
          console.error("Analysis failed:", errorData)
          updateStatusText("Recording... (analysis error - continuing)")
          
          // Clear queue if too many errors pile up
          if (analysisQueue.length > 5) {
            console.warn("Clearing analysis queue due to errors")
            analysisQueue = []
          }
        }
      } catch (error) {
        console.error("Error analyzing chunk:", error)
        updateStatusText("Recording... (error - continuing)")
      } finally {
        // CRITICAL: Wait 5 seconds before processing next chunk
        // Hume batch API needs time between requests
        setTimeout(() => processQueue(), 5000)
      }
    }
    
    reader.readAsDataURL(audioBlob)
  } catch (error) {
    console.error("Error processing chunk:", error)
    setTimeout(() => processQueue(), 1000)
  }
}

// Update status text
function updateStatusText(text) {
  const statusSpan = recordingStatus.querySelector("span:last-child")
  statusSpan.textContent = text
  
  // Add color indicators
  if (text.includes("Analyzing")) {
    statusSpan.style.color = "#f6ad55"
  } else if (text.includes("error")) {
    statusSpan.style.color = "#fc8181"
  } else if (text.includes("detected")) {
    statusSpan.style.color = "#48bb78"
  } else {
    statusSpan.style.color = ""
  }
}

// Start recording
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 16000  // 16kHz for better compatibility
      } 
    })

    // Setup audio context for visualization
    audioContext = new (window.AudioContext || window.webkitAudioContext)()
    analyser = audioContext.createAnalyser()
    const source = audioContext.createMediaStreamSource(stream)
    source.connect(analyser)
    analyser.fftSize = 2048
    const bufferLength = analyser.frequencyBinCount
    dataArray = new Uint8Array(bufferLength)

    // Try WAV format first, fallback to WebM
    let mimeType = 'audio/wav'
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      console.warn('WAV not supported, trying audio/webm')
      mimeType = 'audio/webm;codecs=opus'
    }
    
    // Setup media recorder with time slicing
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      audioBitsPerSecond: 128000
    })
    
    console.log(`Using MIME type: ${mimeType}`)
    
    // Generate session ID
    sessionId = `session_${Date.now()}`
    
    // Clear any previous state
    analysisQueue = []
    isAnalyzing = false
    
    // Store audio chunks to combine into WAV
    let audioChunks = []
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data)
      }
    }
    
    mediaRecorder.onstop = async () => {
      // Combine chunks and convert to WAV
      const audioBlob = new Blob(audioChunks, { type: mimeType })
      
      if (audioBlob.size > MIN_CHUNK_SIZE) {
        // Convert to WAV using AudioContext
        const arrayBuffer = await audioBlob.arrayBuffer()
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
        
        // Convert AudioBuffer to WAV
        const wavBlob = audioBufferToWav(audioBuffer)
        console.log(`Created WAV: ${wavBlob.size} bytes`)
        processAudioChunk(wavBlob)
      }
      
      audioChunks = []
    }

    // Start recording - stop every 30 seconds to create chunks
    mediaRecorder.start()
    isRecording = true
    recordingStartTime = Date.now()
    
    // Create chunks by stopping/starting every 30 seconds
    const chunkInterval = setInterval(() => {
      if (!isRecording) {
        clearInterval(chunkInterval)
        return
      }
      
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.stop()
        
        // Restart recording for next chunk
        setTimeout(() => {
          if (isRecording) {
            audioChunks = []
            mediaRecorder.start()
          }
        }, 100)
      }
    }, CHUNK_DURATION)

    // Update UI
    startBtn.disabled = true
    stopBtn.disabled = false
    recordingStatus.classList.add("recording")
    updateStatusText("Recording... initializing")
    resultsSection.classList.add("active")

    // Start visualization
    setupCanvas()
    drawWaveform()

    console.log("Recording started with 30-second WAV chunks")
  } catch (error) {
    console.error("Error starting recording:", error)
    alert("Could not access microphone. Please check permissions.")
  }
}

// Convert AudioBuffer to WAV blob
function audioBufferToWav(buffer) {
  const numChannels = 1  // Mono
  const sampleRate = 16000
  const format = 1  // PCM
  const bitDepth = 16
  
  // Resample to 16kHz if needed
  let audioData
  if (buffer.sampleRate !== sampleRate) {
    audioData = resampleBuffer(buffer, sampleRate)
  } else {
    audioData = buffer.getChannelData(0)
  }
  
  const dataLength = audioData.length * (bitDepth / 8)
  const buffer_bytes = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer_bytes)
  
  // WAV header
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, format, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true)
  view.setUint16(32, numChannels * (bitDepth / 8), true)
  view.setUint16(34, bitDepth, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataLength, true)
  
  // Write PCM samples
  const offset = 44
  for (let i = 0; i < audioData.length; i++) {
    const sample = Math.max(-1, Math.min(1, audioData[i]))
    view.setInt16(offset + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true)
  }
  
  return new Blob([buffer_bytes], { type: 'audio/wav' })
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i))
  }
}

function resampleBuffer(buffer, targetSampleRate) {
  const sourceSampleRate = buffer.sampleRate
  const sourceData = buffer.getChannelData(0)
  const ratio = sourceSampleRate / targetSampleRate
  const targetLength = Math.round(sourceData.length / ratio)
  const resampledData = new Float32Array(targetLength)
  
  for (let i = 0; i < targetLength; i++) {
    const sourceIndex = i * ratio
    const index = Math.floor(sourceIndex)
    const fraction = sourceIndex - index
    
    if (index + 1 < sourceData.length) {
      resampledData[i] = sourceData[index] * (1 - fraction) + sourceData[index + 1] * fraction
    } else {
      resampledData[i] = sourceData[index]
    }
  }
  
  return resampledData
}

// Stop recording
async function stopRecording() {
  if (mediaRecorder && isRecording) {
    isRecording = false
    
    // Stop media recorder
    mediaRecorder.stop()
    
    // Stop all tracks
    if (mediaRecorder.stream) {
      mediaRecorder.stream.getTracks().forEach(track => track.stop())
    }

    if (audioContext) {
      audioContext.close()
    }

    if (animationId) {
      cancelAnimationFrame(animationId)
    }

    // End session
    try {
      await fetch("/api/end-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ session_id: sessionId }),
      })
    } catch (error) {
      console.error("Error ending session:", error)
    }

    // Update UI
    startBtn.disabled = false
    stopBtn.disabled = true
    recordingStatus.classList.remove("recording")
    updateStatusText("Recording stopped")

    // Clear canvas
    canvasCtx.fillStyle = "rgba(26, 32, 44, 0.5)"
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height)
    
    console.log("Recording stopped")
  }
}

// Update UI with emotion results
function updateUI(result) {
  const { emotion, confidence, voice_features, analysis } = result

  // Update emotion indicator
  const indicator = document.getElementById("emotion-indicator")
  indicator.className = `emotion-indicator ${emotion}`
  
  // Update emoji based on emotion
  const emojiMap = {
    happy: "😊",
    sad: "😢",
    angry: "😠",
    fearful: "😨",
    surprised: "😲",
    neutral: "😐",
    confident: "😎",
    nervous: "😰",
    calm: "😌",
    frustrated: "😤",
    excited: "🤩"
  }
  
  indicator.querySelector(".emotion-icon").textContent = emojiMap[emotion] || "😐"
  indicator.querySelector(".emotion-label").textContent = emotion
  indicator.querySelector(".emotion-confidence").textContent = `${Math.round(confidence * 100)}% confidence`

  // Update analysis text
  document.getElementById("emotion-analysis-text").textContent = analysis

  // Update voice features
  document.getElementById("pitch-value").textContent = voice_features.pitch
  document.getElementById("pace-value").textContent = voice_features.pace
  document.getElementById("energy-value").textContent = voice_features.energy
  document.getElementById("clarity-value").textContent = voice_features.clarity

  // Add to timeline
  const timestamp = new Date().toLocaleTimeString()
  emotionHistory.unshift({ timestamp, emotion, confidence })

  // Keep only last 10 entries
  if (emotionHistory.length > 10) {
    emotionHistory.pop()
  }

  updateTimeline()
}

// Update emotion timeline
function updateTimeline() {
  const timeline = document.getElementById("emotion-timeline")

  if (emotionHistory.length === 0) {
    timeline.innerHTML = '<p class="timeline-empty">No data yet. Start recording to see your emotion timeline.</p>'
    return
  }

  timeline.innerHTML = emotionHistory
    .map(
      (item) => `
        <div class="timeline-item">
            <div class="timeline-time">${item.timestamp}</div>
            <div class="timeline-emotion">${item.emotion}</div>
            <div class="timeline-confidence">${Math.round(item.confidence * 100)}%</div>
        </div>
    `,
    )
    .join("")
}

// Event listeners
startBtn.addEventListener("click", startRecording)
stopBtn.addEventListener("click", stopRecording)
window.addEventListener("resize", setupCanvas)

// Initialize
checkStatus()
setupCanvas()