const video = document.querySelector("#camera");
const canvas = document.querySelector("#motionCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const armButton = document.querySelector("#armButton");
const armLabel = document.querySelector("#armLabel");
const cameraChoices = [...document.querySelectorAll(".camera-choice")];
const cameraHint = document.querySelector("#cameraHint");
const statusText = document.querySelector("#statusText");
const meterFill = document.querySelector("#meterFill");
const sensitivity = document.querySelector("#sensitivity");
const cooldown = document.querySelector("#cooldown");
const stage = document.querySelector(".camera-stage");
const soundPad = document.querySelector(".sound-pad");
const soundImport = document.querySelector("#soundImport");
const recordingStatus = document.querySelector("#recordingStatus");
const recordingList = document.querySelector("#recordingList");
const savedSoundStore = "whoopee-sounds";
let recordDuration = 0;
const soundDelay = 450;
const calibrationDuration = 1000;
const requiredMotionFrames = 10;
const triggerUiDelay = 160;

let stream = null;
let micStream = null;
let audioContext = null;
let soundOutput = null;
let recorderDestination = null;
let micSource = null;
let previousFrame = null;
let baselineFrame = null;
let animationId = null;
let armed = false;
let lastTrigger = 0;
let soundMode = "classic";
let facingMode = "environment";
let activeRecorder = null;
let clipCount = 0;
let armedAt = 0;
let motionStreak = 0;
let resetTimer = null;
let triggerTimer = null;
const importedSounds = new Map();

const setStatus = (text) => {
  statusText.textContent = text;
};

const updateCameraHint = () => {
  const hasCameraApi = !!navigator.mediaDevices?.getUserMedia;
  const secure = window.isSecureContext;
  const protocol = window.location.protocol.replace(":", "");

  cameraHint.textContent = `Secure: ${secure ? "yes" : "no"} | Camera API: ${
    hasCameraApi ? "yes" : "no"
  } | ${protocol}`;
};

const openSoundDb = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open("whoopee-cam", 1);

    request.onupgradeneeded = () => {
      request.result.createObjectStore(savedSoundStore, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const withSoundStore = async (mode, callback) => {
  const db = await openSoundDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(savedSoundStore, mode);
    const store = transaction.objectStore(savedSoundStore);
    const result = callback(store);

    transaction.oncomplete = () => {
      db.close();
      resolve(result);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
};

const makeSoundId = () => `imported:${Date.now()}:${Math.random().toString(36).slice(2)}`;

const addImportedButton = (id, name) => {
  const button = document.createElement("button");

  button.className = "sound-choice";
  button.type = "button";
  button.dataset.sound = id;
  button.textContent = name;
  soundPad.append(button);

  return button;
};

const saveImportedSound = (sound) => withSoundStore("readwrite", (store) => store.put(sound));

const removeImportedSound = (sound) => withSoundStore("readwrite", (store) => store.delete(sound.id));

document.querySelector("#removeSound").addEventListener("click", () => {
  const importedSoundIds = [...importedSounds.keys()];
  if (!importedSoundIds.length) {
    setStatus("No imported sounds");
    return;
  }

  const lastId = importedSoundIds[importedSoundIds.length - 1];
  const sound = importedSounds.get(lastId);
  importedSounds.delete(lastId);
  removeImportedSound({ id: lastId });
  const button = document.querySelector(`.sound-choice[data-sound="${lastId}"]`);
  if (button) {
    button.remove();
  }
  setStatus(`Removed ${sound.name}`);
});

const loadSavedSounds = async () => {
  try {
    const sounds = await withSoundStore("readonly", (store) => {
      const request = store.getAll();

      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });

    for (const sound of sounds) {
      const audio = ensureAudio();
      const buffer = await audio.decodeAudioData(sound.arrayBuffer.slice(0));

      importedSounds.set(sound.id, { buffer, name: sound.name });
      addImportedButton(sound.id, sound.name);
    }
  } catch (error) {
    console.error(error);
  }
};

const ensureAudio = () => {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    audioContext = new AudioContextClass();
    soundOutput = audioContext.createGain();
    recorderDestination = audioContext.createMediaStreamDestination();
    soundOutput.connect(audioContext.destination);
    soundOutput.connect(recorderDestination);
  }

  if (audioContext.state === "suspended") {
    audioContext.resume();
  }

  return audioContext;
};

const connectToSoundOutput = (node) => {
  ensureAudio();
  node.connect(soundOutput);
};

const connectMicrophoneToRecorder = () => {
  if (!micStream || micSource) return;

  ensureAudio();
  micSource = audioContext.createMediaStreamSource(micStream);
  micSource.connect(recorderDestination);
};

const noiseBuffer = (audio, duration) => {
  const frameCount = Math.floor(audio.sampleRate * duration);
  const buffer = audio.createBuffer(1, frameCount, audio.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < frameCount; i += 1) {
    const fade = 1 - i / frameCount;
    data[i] = (Math.random() * 2 - 1) * fade;
  }

  return buffer;
};

const playRandomSound = () => {
  let sounds = document.querySelector(".sound-pad").querySelectorAll('[data-sound*="import"]');
  if(sounds.length === 0){
    sounds = document.querySelector(".sound-pad").querySelectorAll('[data-sound]')
  }
    const randomSound = sounds[Math.floor(Math.random() * sounds.length)];
    soundMode = randomSound.dataset.sound;
}

const playWhoopee = () => {
  if(document.querySelector("#random-sound").checked){
    playRandomSound();
  }
  if (soundMode.startsWith("imported:")) {
    playImportedSound(soundMode);
    return;
  }
  
  const audio = ensureAudio();
  const now = audio.currentTime;
  const duration = soundMode === "squeak" ? 0.42 : soundMode === "chaos" ? 0.9 : 0.62;

  const oscillator = audio.createOscillator();
  const filter = audio.createBiquadFilter();
  const gain = audio.createGain();
  const noise = audio.createBufferSource();
  const noiseGain = audio.createGain();

  oscillator.type = soundMode === "squeak" ? "square" : "sawtooth";
  oscillator.frequency.setValueAtTime(soundMode === "squeak" ? 210 : 118, now);
  oscillator.frequency.exponentialRampToValueAtTime(soundMode === "squeak" ? 88 : 43, now + duration);

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(soundMode === "chaos" ? 980 : 720, now);
  filter.Q.setValueAtTime(7, now);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(soundMode === "chaos" ? 0.38 : 0.28, now + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  noise.buffer = noiseBuffer(audio, duration);
  noiseGain.gain.setValueAtTime(soundMode === "squeak" ? 0.03 : 0.11, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  oscillator.connect(filter);
  filter.connect(gain);
  connectToSoundOutput(gain);
  noise.connect(noiseGain);
  connectToSoundOutput(noiseGain);

  oscillator.start(now);
  noise.start(now);
  oscillator.stop(now + duration);
  noise.stop(now + duration);

  if (soundMode === "chaos") {
    setTimeout(playPop, 120);
  }
};

const playImportedSound = (id) => {
  const imported = importedSounds.get(id);

  if (!imported) {
    setStatus("Pick sound");
    return;
  }

  const audio = ensureAudio();
  const source = audio.createBufferSource();
  const gain = audio.createGain();

  source.buffer = imported.buffer;
  gain.gain.value = 0.95;
  source.connect(gain);
  connectToSoundOutput(gain);
  source.start();
};

const playPop = () => {
  const audio = ensureAudio();
  const now = audio.currentTime;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();

  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(180, now);
  oscillator.frequency.exponentialRampToValueAtTime(55, now + 0.16);
  gain.gain.setValueAtTime(0.18, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  oscillator.connect(gain);
  connectToSoundOutput(gain);
  oscillator.start(now);
  oscillator.stop(now + 0.18);
};

const recordingMimeType = () => {
  const options = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm", "video/mp4"];

  return options.find((type) => MediaRecorder.isTypeSupported(type)) || "";
};

const addRecording = (blob) => {
  clipCount += 1;
  const url = URL.createObjectURL(blob);
  const card = document.createElement("article");
  const preview = document.createElement("video");
  const link = document.createElement("a");
  const extension = blob.type.includes("mp4") ? "mp4" : "webm";

  card.className = "recording-card";
  preview.src = url;
  preview.controls = true;
  preview.playsInline = true;
  link.href = url;
  link.download = `whoopee-cam-${clipCount}.${extension}`;
  link.textContent = "Save";
  card.append(preview, link);
  recordingList.prepend(card);
  recordingStatus.textContent = `${clipCount} saved`;
};

const resetDetector = () => {
  previousFrame = null;
  baselineFrame = null;
  motionStreak = 0;
  armedAt = Date.now();
  meterFill.style.height = "0%";

  if (!armed) return;

  // setStatus("Calibrating");

  if (resetTimer) {
    window.clearTimeout(resetTimer);
  }

  if (triggerTimer) {
    window.clearTimeout(triggerTimer);
    triggerTimer = null;
  }
  
  if (armed && !activeRecorder) setStatus("Armed");
};

const recordTriggerClip = () => {
  if (!("MediaRecorder" in window)) {
    recordingStatus.textContent = "No recorder";
    return false;
  }

  if (!stream || activeRecorder) {
    return false;
  }

  ensureAudio();

  const tracks = [...stream.getVideoTracks(), ...recorderDestination.stream.getAudioTracks()];
  const recordingStream = new MediaStream(tracks);
  const mimeType = recordingMimeType();
  const chunks = [];

  activeRecorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
  activeRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });
  activeRecorder.addEventListener("stop", () => {
    const blob = new Blob(chunks, { type: activeRecorder.mimeType || "video/webm" });

    addRecording(blob);
    activeRecorder = null;
    stage.classList.remove("is-recording");
    resetDetector();
  });

  activeRecorder.start();
  stage.classList.add("is-recording");
  recordingStatus.textContent = "Recording...";
  setStatus("Recording");

  if(document.querySelector("#record-video").checked){
    recordDuration = 6000;
  }
  window.setTimeout(() => {
    if (activeRecorder?.state === "recording") {
      activeRecorder.stop();
    }
  }, recordDuration);

  return true;
};

const handlewhoopeeTrigger = () => {
  playWhoopee();
  stage.classList.add("is-triggered");
  window.setTimeout(() => {
    stage.classList.remove("is-triggered");
    if (armed) resetDetector();
  }, 520);
}
const handleMotionTrigger = () => {
  lastTrigger = Date.now();
  motionStreak = 0;
  meterFill.style.height = "100%";
  const shouldRecord = document.querySelector("#record-video").checked;
  const isRecording = shouldRecord && recordTriggerClip();

    setStatus("Motion!");
  if (!isRecording) {
    handlewhoopeeTrigger();
  }
  else{
  window.setTimeout(() => {
    handlewhoopeeTrigger();
  }, soundDelay);
  }
};

const getLuminance = (data, index) =>
  0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];

const updateBaselineFrame = (frame, blendAmount) => {
  if (!baselineFrame) {
    baselineFrame = new Uint8ClampedArray(frame.data);
    return;
  }

  for (let i = 0; i < frame.data.length; i += 4) {
    baselineFrame[i] = baselineFrame[i] * (1 - blendAmount) + frame.data[i] * blendAmount;
    baselineFrame[i + 1] = baselineFrame[i + 1] * (1 - blendAmount) + frame.data[i + 1] * blendAmount;
    baselineFrame[i + 2] = baselineFrame[i + 2] * (1 - blendAmount) + frame.data[i + 2] * blendAmount;
    baselineFrame[i + 3] = 255;
  }
};

const motionScoreForFrame = (frame) => {
  if (!previousFrame || !baselineFrame) {
    updateBaselineFrame(frame, 1);
    return 0;
  }

  let fastChanges = 0;
  let slowChanges = 0;
  const sampleStep = 8;

  for (let i = 0; i < frame.data.length; i += sampleStep) {
    const currentLuma = getLuminance(frame.data, i);
    const prevLuma = getLuminance(previousFrame.data, i);
    const baseLuma = getLuminance(baselineFrame, i);

    const fastDelta = Math.abs(currentLuma - prevLuma);
    const slowDelta = Math.abs(currentLuma - baseLuma);

    if (fastDelta > 28) {
      fastChanges += 1;
    }

    if (slowDelta > 20) {
      slowChanges += 1;
    }
  }

  const sampledPixels = frame.data.length / sampleStep;
  const fastScore = (fastChanges / sampledPixels) * 100;
  const slowScore = (slowChanges / sampledPixels) * 100;
  const score = Math.round(Math.max(fastScore, slowScore * 0.9));

  const isCalibrating = Date.now() - armedAt < calibrationDuration;
  const blendAmount = isCalibrating ? 0.22 : score > 6 ? 0.012 : 0.04;

  updateBaselineFrame(frame, blendAmount);

  return score;
};

const detectMotion = () => {
  if (!armed || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    animationId = requestAnimationFrame(detectMotion);
    return;
  }

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);

  if (activeRecorder) {
    if (triggerTimer) {
      window.clearTimeout(triggerTimer);
      triggerTimer = null;
    }

    updateBaselineFrame(frame, baselineFrame ? 0.08 : 1);
    previousFrame = frame;
    motionStreak = 0;
    meterFill.style.height = "0%";
    animationId = requestAnimationFrame(detectMotion);
    return;
  }

  const motionScore = motionScoreForFrame(frame);

  const threshold = 62 - Number(sensitivity.value) * 0.46;
  const calibrated = Date.now() - armedAt > calibrationDuration;
  const canTrigger = Date.now() - lastTrigger > Math.max(Number(cooldown.value), recordDuration);

  if (!calibrated) {
    motionStreak = 0;
  } else if (motionScore >= threshold) {
    motionStreak += 1;
  } else if (motionScore >= threshold * 0.45) {
    motionStreak += 0.25;
  } else {
    motionStreak = Math.max(0, motionStreak - 0.5);
  }

  motionStreak = Math.min(requiredMotionFrames, motionStreak);
  const triggerProgress = calibrated && canTrigger ? (motionStreak / requiredMotionFrames) * 100 : 0;
  meterFill.style.height = `${Math.min(100, triggerProgress)}%`;

  if (motionStreak >= requiredMotionFrames && canTrigger && !triggerTimer) {
    meterFill.style.height = "100%";
    triggerTimer = window.setTimeout(() => {
      triggerTimer = null;

      if (!armed || activeRecorder) return;

      motionStreak = 0;
      handleMotionTrigger();
    }, triggerUiDelay);
  }

  previousFrame = frame;
  animationId = requestAnimationFrame(detectMotion);
};

const startCamera = async () => {
  ensureAudio();
  const constraints = {
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  };

  if (!micStream) {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    connectMicrophoneToRecorder();
  }

  stream = await navigator.mediaDevices.getUserMedia({
    ...constraints,
  });

  video.srcObject = stream;
  video.classList.toggle("is-front-camera", facingMode === "user");
  await video.play();
  armed = true;
  armLabel.textContent = "Stop camera";
  resetDetector();
  detectMotion();
};

const stopCamera = ({ keepStatus = false } = {}) => {
  armed = false;
  motionStreak = 0;
  previousFrame = null;
  baselineFrame = null;
  meterFill.style.height = "0%";
  armLabel.textContent = "Start camera";

  if (!keepStatus) {
    setStatus("Ready to arm");
  }

  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  if (resetTimer) {
    window.clearTimeout(resetTimer);
    resetTimer = null;
  }

  if (triggerTimer) {
    window.clearTimeout(triggerTimer);
    triggerTimer = null;
  }

  if (activeRecorder?.state === "recording") {
    activeRecorder.stop();
  }

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
    micSource = null;
  }

  video.srcObject = null;
};

const setFacingMode = async (nextFacingMode) => {
  if (facingMode === nextFacingMode) return;

  facingMode = nextFacingMode;
  cameraChoices.forEach((choice) => {
    choice.classList.toggle("is-active", choice.dataset.facing === facingMode);
  });

  if (!armed) {
    video.classList.toggle("is-front-camera", facingMode === "user");
    return;
  }

  stopCamera({ keepStatus: true });
  setStatus("Switching");
  armLabel.textContent = "Switching...";

  try {
    await startCamera();
  } catch (error) {
    console.error(error);
    armLabel.textContent = "Start camera";
    setStatus("Cam/mic blocked");
  }
};

armButton.addEventListener("click", async () => {
  if (armed) {
    stopCamera();
    return;
  }

  try {
    armLabel.textContent = "Starting...";
    await startCamera();
  } catch (error) {
    console.error(error);
    armLabel.textContent = "Start camera";
    setStatus("Cam/mic blocked");
  }
});

cameraChoices.forEach((choice) => {
  choice.addEventListener("click", () => {
    setFacingMode(choice.dataset.facing);
  });
});

updateCameraHint();

if (!window.isSecureContext && !navigator.mediaDevices?.getUserMedia) {
  armButton.disabled = true;
  setStatus("Needs HTTPS");
} else if (!navigator.mediaDevices?.getUserMedia) {
  armButton.disabled = true;
  setStatus("No camera API");
}

if (!("MediaRecorder" in window)) {
  recordingStatus.textContent = "No recorder";
}

const selectSound = (button) => {
  soundMode = button.dataset.sound;
  document.querySelectorAll(".sound-choice").forEach((choice) => {
    choice.classList.toggle("is-active", choice === button);
  });
  playWhoopee();
};

soundPad.addEventListener("click", (event) => {
  const button = event.target.closest(".sound-choice");

  if (!button) return;

  selectSound(button);
});

async function handleAudioFiles(fileList) {
  const files = [...fileList].filter((file) =>
    file.type.startsWith("audio/")
  );

  if (!files.length) return;

  const audio = ensureAudio();

  for (const file of files) {
    try {
      const id = makeSoundId();

      const arrayBuffer = await file.arrayBuffer();
      const buffer = await audio.decodeAudioData(arrayBuffer.slice(0));

      const name =
        file.name.replace(/\.[^.]+$/, "").slice(0, 18) || "Imported";

      importedSounds.set(id, { buffer, name });
      const button = addImportedButton(id, name);

      selectSound(button);
      setStatus("Sound loaded");

      try {
        await saveImportedSound({ id, name, arrayBuffer });
      } catch (error) {
        console.error(error);
      }
    } catch (error) {
      console.error(error);
      setStatus("Bad audio");
    }
  }
}

soundImport.addEventListener("change", async () => {
  await handleAudioFiles(soundImport.files);
  soundImport.value = "";
});

loadSavedSounds();


const dropZone = document.querySelector(".drop-zone");

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");

});


dropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");

  await handleAudioFiles(e.dataTransfer.files);
});


dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});

document.querySelector("#rotate-camera").addEventListener("click", () => {
  document.querySelector(
  "div.camera-switch button:not(.is-active)"
).click();
});


// Record audio clip

let mediaRecorder;
let chunks = [];

const startBtn = document.getElementById("start-audio-recording");
const stopBtn = document.getElementById("stop-audio-recording");

//
// SAVE RECORDING
//
async function saveRecording(blob) {
  handleAudioFiles([new File([blob], `whoopee-${Date.now()}.webm`, { type: blob.type })]);
}

//
// START RECORDING
//

startBtn.onclick = async () => {
  setStatus("Recording audio...");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true
  });

  chunks = [];

  mediaRecorder = new MediaRecorder(stream, {
    mimeType: "audio/webm"
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, {
      type: "audio/webm"
    });

    await saveRecording(blob);
  };

  mediaRecorder.start();
};

//
// STOP RECORDING
//
stopBtn.onclick = () => {
  if (mediaRecorder) {
    mediaRecorder.stop();
  }
};