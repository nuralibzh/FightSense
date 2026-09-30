// Camera tracking and the five movement rules used in a training session.
const video = document.getElementById("webcam");
const canvas = document.getElementById("poseCanvas");
const context = canvas.getContext("2d");
const levelButtons = [...document.querySelectorAll(".level-button")];
const selection = document.getElementById("levelSelection");
const training = document.getElementById("activeTraining");
const info = document.getElementById("trainingInfo");
const results = document.getElementById("sessionResults");
const feedbackBox = document.getElementById("feedbackBox");
const feedbackText = document.getElementById("feedbackText");
const correctionNotes = document.getElementById("correctionNotes");
const correctionList = document.getElementById("correctionList");

const levels = {
    Beginner: { moves: ["JAB", "CROSS", "GUARD", "JAB", "CROSS", "GUARD"], seconds: 14 },
    Amateur: { moves: ["JAB", "CROSS", "GUARD", "SLIP", "JAB", "CROSS", "SLIP", "GUARD"], seconds: 12 },
    Pro: { moves: ["JAB", "CROSS", "GUARD", "SLIP", "DUCK", "JAB", "CROSS", "SLIP", "DUCK", "GUARD"], seconds: 10 }
};

const instructions = {
    JAB: "Extend your LEFT hand toward the camera. Keep your right fist up.",
    CROSS: "Extend your RIGHT hand toward the camera. Keep your left fist up.",
    GUARD: "Raise both fists beside your face and hold your guard.",
    SLIP: "Move your head to either side while your shoulders stay almost level.",
    DUCK: "Bend your knees and lower your head and shoulders together."
};

let poseLandmarker = null;
let poseConnections = [];
let cameraStream = null;
let frameId = null;
let session = null;
let starting = false;
let lastVideoTime = -1;
let lastDetection = 0;

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function elbowAngle(shoulder, elbow, wrist) {
    const ax = shoulder.x - elbow.x;
    const ay = shoulder.y - elbow.y;
    const bx = wrist.x - elbow.x;
    const by = wrist.y - elbow.y;
    const cosine = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
}

function isVisible(point) {
    return point && (point.visibility === undefined || point.visibility > 0.45);
}

function hasUpperBody(points) {
    return [0, 11, 12, 13, 14, 15, 16].every((index) => isVisible(points[index]));
}

function setFeedback(message, good = false, force = false) {
    const now = performance.now();
    if (!force && session?.feedbackUntil > now && feedbackText.textContent !== message) return;
    feedbackBox.style.display = "block";
    feedbackBox.classList.toggle("success", good);
    feedbackText.textContent = message;
    if (session && feedbackText.textContent === message) {
        session.feedbackUntil = force ? 0 : now + (good ? 1200 : 5000);
    }
}

function showCorrections(list, notes) {
    list.replaceChildren();
    for (const note of notes) {
        const item = document.createElement("li");
        const move = document.createElement("strong");
        move.textContent = note.move + ": ";
        item.append(move, document.createTextNode(note.message));
        list.append(item);
    }
}

function rememberCorrection(message) {
    if (!session || session.phase !== "move" || !message) return;
    const key = session.index + ":" + message;
    if (session.seenCorrections.has(key)) return;
    session.seenCorrections.add(key);
    session.corrections.unshift({ move: session.moves[session.index], message });
    correctionNotes.hidden = false;
    showCorrections(correctionList, session.corrections);
}

function setStatus(message) {
    document.getElementById("webcamStatusText").textContent = message;
}

async function loadPoseLandmarker() {
    if (poseLandmarker) return;

    const version = "0.10.35";
    const { FilesetResolver, PoseLandmarker } = await import(
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${version}/vision_bundle.mjs`
    );
    const vision = await FilesetResolver.forVisionTasks(
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${version}/wasm`
    );
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            delegate: "CPU"
        },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });
    poseConnections = PoseLandmarker.POSE_CONNECTIONS;
}

function stopCamera() {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    video.srcObject = null;
    context.clearRect(0, 0, canvas.width, canvas.height);
}

function resetScoreboard() {
    document.getElementById("trainingLevel").textContent = session.level;
    document.getElementById("currentRound").textContent = "1";
    document.getElementById("totalRounds").textContent = "1";
    document.getElementById("totalMoves").textContent = session.moves.length;
    document.getElementById("completedMoves").textContent = "0";
    updateScoreboard();
}

function updateScoreboard() {
    const attempted = session.index;
    const accuracy = attempted ? Math.round(session.hits / attempted * 100) : 0;
    const average = session.times.length
        ? (session.times.reduce((sum, time) => sum + time, 0) / session.times.length / 1000).toFixed(1) + " s"
        : "—";
    document.getElementById("scoreValue").textContent = session.score;
    document.getElementById("comboValue").textContent = "x" + session.combo;
    document.getElementById("accuracyValue").textContent = accuracy + "%";
    document.getElementById("reactionValue").textContent = average;
    document.getElementById("completedMoves").textContent = attempted;
    document.getElementById("scoreBar").style.width = Math.min(100, session.score / (session.moves.length * 120) * 100) + "%";
    document.getElementById("comboBar").style.width = Math.min(100, session.combo / 5 * 100) + "%";
    document.getElementById("accuracyBar").style.width = accuracy + "%";
    document.getElementById("reactionBar").style.width = session.times.length
        ? Math.max(0, 100 - parseFloat(average) * 10) + "%" : "0%";
}

function startMove(now) {
    session.phase = "move";
    session.moveStart = now;
    session.armed = false;
    session.holdStart = null;
    const move = session.moves[session.index];
    document.getElementById("currentMove").textContent = move;
    document.getElementById("nextMove").textContent = session.moves[session.index + 1] || "FINISH";
    setFeedback(instructions[move], false, true);
    setStatus("Tracking active");
}

function completeMove(success, now, message) {
    if (session.phase !== "move") return;
    if (success) {
        session.hits += 1;
        session.combo += 1;
        session.bestCombo = Math.max(session.bestCombo, session.combo);
        session.times.push(now - session.moveStart);
        const movePoints = { JAB: 100, CROSS: 120, GUARD: 80, SLIP: 110, DUCK: 110 };
        session.score += movePoints[session.moves[session.index]]
            + Math.max(0, Math.round((session.seconds * 1000 - (now - session.moveStart)) / 1000) * 5);
    } else {
        session.combo = 0;
    }
    setFeedback(message, success, true);
    setStatus(success ? "Move recognized" : "Try the next move");
    session.phase = "pause";
    session.resumeAt = now + 1200;
    session.index += 1;
    updateScoreboard();
}

function finishSession(endedEarly = false) {
    if (!session) return;
    stopCamera();
    const total = session.moves.length;
    const attempted = session.index;
    const accuracy = attempted ? Math.round(session.hits / attempted * 100) : 0;
    document.getElementById("resultsMessage").textContent = endedEarly
        ? "Session ended. Here is what you completed."
        : "You finished the round. Try again to beat your score.";
    document.getElementById("resultScore").textContent = session.score;
    document.getElementById("resultMoves").textContent = session.hits + " / " + total;
    document.getElementById("resultAccuracy").textContent = accuracy + "%";
    document.getElementById("resultCombo").textContent = session.bestCombo;
    const resultCorrections = document.getElementById("resultCorrections");
    resultCorrections.hidden = session.corrections.length === 0;
    if (session.corrections.length) {
        showCorrections(document.getElementById("resultCorrectionList"), session.corrections);
    }
    session = null;
    training.hidden = true;
    info.hidden = true;
    results.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function evaluatePunch(move, points, world) {
    // MediaPipe left/right refers to the user's own body, even in the mirrored preview.
    const left = move === "JAB";
    const shoulder = points[left ? 11 : 12];
    const elbow = points[left ? 13 : 14];
    const wrist = points[left ? 15 : 16];
    const otherShoulder = points[left ? 12 : 11];
    const otherElbow = points[left ? 14 : 13];
    const otherWrist = points[left ? 16 : 15];
    const width = distance(points[11], points[12]);
    const angle = elbowAngle(shoulder, elbow, wrist);
    const otherAngle = elbowAngle(otherShoulder, otherElbow, otherWrist);
    const hand = left ? "left" : "right";

    if (angle < 125 || distance(wrist, points[0]) < width * 1.1) session.armed = true;
    if (!session.armed) return { hint: `Bring your ${hand} fist back near your chin first.` };
    if (otherAngle > 150 && otherWrist.y < otherShoulder.y + width * 0.5)
        return { hint: `Use your ${hand} hand for this punch, not the other hand.` };
    if (wrist.y > shoulder.y + width * 0.5)
        return { hint: `Raise your ${hand} fist to shoulder height.` };

    const forwardInDepth = world && world[left ? 15 : 16] && world[left ? 11 : 12]
        && world[left ? 15 : 16].z < world[left ? 11 : 12].z - 0.10;
    const longInFrame = distance(wrist, shoulder) > width * 0.72;
    if (angle < 145 || (!longInFrame && !forwardInDepth))
        return { hint: `Straighten your ${hand} arm toward the camera.` };
    if (otherWrist.y > otherShoulder.y + width * 0.8)
        return { hint: "Keep your other fist up to protect your face." };
    return { ok: true };
}

function evaluateMove(move, points, world) {
    const width = distance(points[11], points[12]);
    const shoulderX = (points[11].x + points[12].x) / 2;
    const shoulderY = (points[11].y + points[12].y) / 2;
    const nose = points[0];

    if (move === "JAB" || move === "CROSS") return evaluatePunch(move, points, world);
    if (move === "GUARD") {
        if (points[15].y > points[11].y + width * 0.4)
            return { hint: "Raise your left fist beside your face." };
        if (points[16].y > points[12].y + width * 0.4)
            return { hint: "Raise your right fist beside your face." };
        if (distance(points[15], nose) > width * 1.3 || distance(points[16], nose) > width * 1.3)
            return { hint: "Bring both fists closer to your cheeks." };
        return { ok: true };
    }
    if (move === "SLIP") {
        const headOffset = nose.x - shoulderX;
        if (Math.abs(headOffset - session.neutral.headOffset) < width * 0.27)
            return { hint: "Move your head farther left or right, away from the center." };
        if (shoulderY - session.neutral.shoulderY > width * 0.3)
            return { hint: "Keep your shoulders level; shift your head sideways instead of ducking." };
        return { ok: true };
    }
    if (move === "DUCK") {
        if (nose.y - session.neutral.noseY < width * 0.40)
            return { hint: "Lower your head more to get under the punch." };
        if (shoulderY - session.neutral.shoulderY < width * 0.20)
            return { hint: "Bend your knees and lower your shoulders too, not only your neck." };
        return { ok: true };
    }
    return { hint: "Move into the camera frame." };
}

function processPose(points, world, now, delta) {
    if (!session) return;
    if (session.phase === "pause") {
        if (now >= session.resumeAt) {
            if (session.index >= session.moves.length) finishSession();
            else startMove(now);
        }
        return;
    }
    if (!points || !hasUpperBody(points)) {
        if (session.phase === "move") session.moveStart += delta;
        setStatus("Move into frame");
        const hint = "Keep your head, shoulders and both hands visible in the camera.";
        rememberCorrection(hint);
        setFeedback(hint);
        return;
    }

    if (session.phase === "ready") {
        const shoulders = (points[11].y + points[12].y) / 2;
        session.samples.push({
            noseY: points[0].y,
            shoulderY: shoulders,
            headOffset: points[0].x - (points[11].x + points[12].x) / 2
        });
        setStatus("Position found");
        if (session.samples.length === 1) {
            setFeedback("Hold still for a moment. Keep your left hand in front for the jab.", true, true);
        }
        if (session.samples.length >= 8) {
            session.neutral = {
                noseY: session.samples.reduce((sum, item) => sum + item.noseY, 0) / session.samples.length,
                shoulderY: session.samples.reduce((sum, item) => sum + item.shoulderY, 0) / session.samples.length,
                headOffset: session.samples.reduce((sum, item) => sum + item.headOffset, 0) / session.samples.length
            };
            startMove(now);
        }
        return;
    }

    const move = session.moves[session.index];
    const verdict = evaluateMove(move, points, world);
    if (verdict.ok) {
        if (session.holdStart === null) session.holdStart = now;
        const holdTime = move === "GUARD" ? 650 : (move === "JAB" || move === "CROSS" ? 100 : 350);
        setFeedback("Good form — hold it!", true);
        if (now - session.holdStart >= holdTime) completeMove(true, now, "Good " + move.toLowerCase() + "! Next move coming up.");
    } else {
        session.holdStart = null;
        rememberCorrection(verdict.hint);
        setFeedback(verdict.hint);
    }
    if (session.phase === "move" && now - session.moveStart >= session.seconds * 1000)
        completeMove(false, now, verdict.hint || "Time is up. Try the next move.");
}

function drawPose(points) {
    const width = canvas.clientWidth * Math.min(window.devicePixelRatio || 1, 2);
    const height = canvas.clientHeight * Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width) || canvas.height !== Math.round(height)) {
        canvas.width = Math.round(width);
        canvas.height = Math.round(height);
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!points) return;

    const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
    const offsetX = (canvas.width - video.videoWidth * scale) / 2;
    const offsetY = (canvas.height - video.videoHeight * scale) / 2;
    const position = (point) => ({
        x: offsetX + point.x * video.videoWidth * scale,
        y: offsetY + point.y * video.videoHeight * scale
    });
    context.strokeStyle = "#e3ae49";
    context.lineWidth = Math.max(2, canvas.width / 400);
    for (const connection of poseConnections) {
        if (!isVisible(points[connection.start]) || !isVisible(points[connection.end])) continue;
        const start = position(points[connection.start]);
        const end = position(points[connection.end]);
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
    }
    context.fillStyle = "#47e8a2";
    for (const index of [0, 11, 12, 13, 14, 15, 16, 23, 24]) {
        if (!isVisible(points[index])) continue;
        const point = position(points[index]);
        context.beginPath();
        context.arc(point.x, point.y, Math.max(3, canvas.width / 220), 0, Math.PI * 2);
        context.fill();
    }
}

function render(now) {
    if (!session) return;
    session.lastTick = now;
    if (session.phase === "move") {
        const seconds = Math.max(0, Math.ceil(session.seconds - (now - session.moveStart) / 1000));
        document.getElementById("timerValue").textContent = "0:" + String(seconds).padStart(2, "0");
    }

    if (video.readyState >= 2 && video.videoWidth > 0 && now - lastDetection >= 100 && video.currentTime !== lastVideoTime) {
        const detectionGap = lastDetection ? Math.min(now - lastDetection, 250) : 0;
        lastDetection = now;
        lastVideoTime = video.currentTime;
        try {
            const result = poseLandmarker.detectForVideo(video, now);
            const points = result.landmarks[0];
            drawPose(points);
            processPose(points, result.worldLandmarks?.[0], now, detectionGap);
        } catch (error) {
            console.error("Camera tracking error:", error);
            finishSession(true);
            return;
        }
    }
    if (session) frameId = requestAnimationFrame(render);
}

async function startSession(level) {
    if (starting || session) return;
    starting = true;
    levelButtons.forEach((button) => button.disabled = true);
    const startStatus = document.getElementById("startStatus");
    startStatus.textContent = "Preparing camera tracking...";

    try {
        if (!navigator.mediaDevices?.getUserMedia)
            throw new Error("Camera access requires HTTPS or a local server.");
        await loadPoseLandmarker();
        startStatus.textContent = "Allow camera access in your browser...";
        cameraStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }
        });
        video.srcObject = cameraStream;
        await video.play();
        const config = levels[level];
        session = {
            level,
            moves: config.moves,
            seconds: config.seconds,
            index: 0,
            hits: 0,
            score: 0,
            combo: 0,
            bestCombo: 0,
            times: [],
            corrections: [],
            seenCorrections: new Set(),
            feedbackUntil: 0,
            phase: "ready",
            samples: [],
            neutral: null,
            armed: false,
            holdStart: null,
            lastTick: performance.now()
        };
        resetScoreboard();
        correctionNotes.hidden = true;
        correctionList.replaceChildren();
        document.getElementById("currentMove").textContent = "READY";
        document.getElementById("nextMove").textContent = config.moves[0];
        document.getElementById("timerValue").textContent = "--";
        selection.hidden = true;
        results.hidden = true;
        training.hidden = false;
        info.hidden = false;
        setStatus("Looking for your position");
        setFeedback("Stand facing the camera with your head, shoulders and both hands visible.", false, true);
        lastVideoTime = -1;
        lastDetection = 0;
        frameId = requestAnimationFrame(render);
        window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
        console.error("Could not start training:", error);
        stopCamera();
        const reason = error.name === "NotAllowedError"
            ? "Camera permission was denied. Allow access and try again."
            : error.name === "NotFoundError"
                ? "No camera was found on this device."
                : error.message.includes("HTTPS")
                    ? error.message
                    : "Could not start camera tracking. Check your connection and try again.";
        startStatus.textContent = reason;
    } finally {
        starting = false;
        levelButtons.forEach((button) => button.disabled = false);
    }
}

levelButtons.forEach((button) => {
    button.addEventListener("click", () => startSession(button.dataset.level));
});
document.getElementById("endSession").addEventListener("click", () => finishSession(true));
document.getElementById("restartTraining").addEventListener("click", () => {
    results.hidden = true;
    selection.hidden = false;
    document.getElementById("startStatus").textContent = "";
    document.getElementById("chooseLevel").scrollIntoView({ behavior: "smooth" });
});
window.addEventListener("pagehide", stopCamera);
