/**
 * Utility to generate client-side procedural sample videos for instant testing
 * without requiring the user to upload a local video file.
 */

export interface SampleVideoInfo {
  id: string;
  title: string;
  duration: string;
  description: string;
  type: 'ball' | 'dual' | 'shadow';
}

export const SAMPLE_VIDEOS: SampleVideoInfo[] = [
  {
    id: 'sample-ball',
    title: 'Moving Sphere',
    duration: '0:04',
    description: 'High-contrast glowing sphere gliding across frame',
    type: 'ball',
  },
  {
    id: 'sample-dual',
    title: 'Dual Elements',
    duration: '0:05',
    description: 'Two separate moving subjects crossing paths',
    type: 'dual',
  },
  {
    id: 'sample-shadow',
    title: 'Subject & Reflection',
    duration: '0:05',
    description: 'Moving subject with floor reflection / cast shadow',
    type: 'shadow',
  },
];

/**
 * Procedurally renders animation frames onto a hidden canvas and records it
 * via MediaRecorder into a standard video File.
 */
export async function createSampleVideoFile(type: SampleVideoInfo['type']): Promise<File> {
  const width = 640;
  const height = 360;
  const fps = 30;
  const durationSec = type === 'ball' ? 4 : 5;
  const totalFrames = fps * durationSec;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context not available');
  }

  // Determine supported mime type
  const mimeTypes = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  let selectedMime = 'video/webm';
  for (const mime of mimeTypes) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      selectedMime = mime;
      break;
    }
  }

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, {
    mimeType: selectedMime,
    videoBitsPerSecond: 2_500_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  const recordingPromise = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: selectedMime }));
    };
    recorder.onerror = (e) => reject(e);
  });

  recorder.start();

  // Render animation loop
  for (let f = 0; f < totalFrames; f++) {
    const progress = f / totalFrames;

    // Dark studio background with subtle grid
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, width, height);

    // Subtle background grid
    ctx.strokeStyle = '#18181b';
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Floor line
    const floorY = height * 0.72;
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, floorY);
    ctx.lineTo(width, floorY);
    ctx.stroke();

    if (type === 'ball') {
      // Single smooth bouncing ball
      const x = 80 + progress * (width - 160);
      const bounce = Math.abs(Math.sin(progress * Math.PI * 4));
      const radius = 32;
      const y = floorY - radius - bounce * 110;

      // Cast shadow on floor
      const shadowW = radius * (1.2 - bounce * 0.5);
      const shadowH = radius * 0.25;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.beginPath();
      ctx.ellipse(x, floorY + 4, shadowW, shadowH, 0, 0, Math.PI * 2);
      ctx.fill();

      // Glowing sphere
      const grad = ctx.createRadialGradient(x - 8, y - 10, 4, x, y, radius);
      grad.addColorStop(0, '#a3e635'); // Lime green core
      grad.addColorStop(0.7, '#65a30d');
      grad.addColorStop(1, '#365314');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (type === 'dual') {
      // Subject 1: Blue box moving left -> right
      const x1 = 70 + progress * (width - 140);
      const y1 = height * 0.45 + Math.sin(progress * Math.PI * 3) * 30;
      const boxSize = 54;
      ctx.fillStyle = '#06b6d4';
      ctx.fillRect(x1 - boxSize / 2, y1 - boxSize / 2, boxSize, boxSize);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x1 - boxSize / 2, y1 - boxSize / 2, boxSize, boxSize);

      // Subject 2: Pink diamond moving right -> left
      const x2 = width - 70 - progress * (width - 140);
      const y2 = height * 0.48 - Math.cos(progress * Math.PI * 3) * 35;
      const dSize = 30;
      ctx.fillStyle = '#ec4899';
      ctx.beginPath();
      ctx.moveTo(x2, y2 - dSize);
      ctx.lineTo(x2 + dSize, y2);
      ctx.lineTo(x2, y2 + dSize);
      ctx.lineTo(x2 - dSize, y2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      // Subject & Floor Reflection
      const x = 90 + progress * (width - 180);
      const y = floorY - 60;
      const bodyW = 44;
      const bodyH = 70;

      // Floor Reflection (diffuse)
      ctx.fillStyle = 'rgba(163, 230, 53, 0.25)';
      ctx.beginPath();
      ctx.ellipse(x, floorY + 18, bodyW * 0.9, bodyH * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();

      // Main Standing Subject
      const grad = ctx.createLinearGradient(x, y - bodyH / 2, x, y + bodyH / 2);
      grad.addColorStop(0, '#e4e4e7');
      grad.addColorStop(1, '#a1a1aa');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x - bodyW / 2, y - bodyH / 2, bodyW, bodyH, 12);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Frame stamp in corner
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '12px monospace';
    ctx.fillText(`SAMPLE CLIP: ${type.toUpperCase()} | FRAME ${f + 1}/${totalFrames}`, 16, 24);

    // Yield control so canvas stream captures frame
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }

  recorder.stop();
  const blob = await recordingPromise;
  const extension = selectedMime.includes('mp4') ? 'mp4' : 'webm';
  const filename = `stirs_${type}_demo.${extension}`;

  return new File([blob], filename, { type: selectedMime });
}
