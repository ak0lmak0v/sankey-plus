function parsePath(d) {
  // Supports only the subset we generate: M, L, A commands.
  const tokens = [];
  const re = /([MLA])([^MLA]*)/g;
  let m;
  while ((m = re.exec(d))) {
    const cmd = m[1];
    const nums = (m[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
    tokens.push({ cmd, nums });
  }
  return tokens;
}

function arcToCenter(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
  // Implementation based on SVG spec: endpoint to center parameterization.
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // Step 1: compute (x1', y1')
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // Ensure radii are positive.
  rx = Math.abs(rx);
  ry = Math.abs(ry);

  // Step 2: correct radii if too small
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }

  // Step 3: compute (cx', cy')
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;

  let sign = fa === fs ? -1 : 1;
  let sq = (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2) / (rx2 * y1p2 + ry2 * x1p2);
  sq = Math.max(0, sq);
  const coef = sign * Math.sqrt(sq);
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;

  // Step 4: compute (cx, cy)
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  // Step 5: compute angles
  const vMag = (ux, uy) => Math.sqrt(ux * ux + uy * uy);
  const vDot = (ux, uy, vx, vy) => ux * vx + uy * vy;
  const vAng = (ux, uy, vx, vy) => {
    const dot = vDot(ux, uy, vx, vy);
    const mag = vMag(ux, uy) * vMag(vx, vy);
    const c = Math.min(1, Math.max(-1, dot / (mag || 1)));
    const s = ux * vy - uy * vx;
    return Math.atan2(s, c);
  };

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;

  let theta1 = vAng(1, 0, ux, uy);
  let dtheta = vAng(ux, uy, vx, vy);

  if (!fs && dtheta > 0) dtheta -= 2 * Math.PI;
  if (fs && dtheta < 0) dtheta += 2 * Math.PI;

  return { cx, cy, rx, ry, phi, theta1, dtheta };
}

function samplePath(d, samplesPerSeg = 80) {
  const cmds = parsePath(d);
  const pts = [];
  let x = 0;
  let y = 0;

  for (const c of cmds) {
    if (c.cmd === "M") {
      x = c.nums[0];
      y = c.nums[1];
      pts.push([x, y]);
      continue;
    }
    if (c.cmd === "L") {
      const x2 = c.nums[0];
      const y2 = c.nums[1];
      for (let i = 1; i <= samplesPerSeg; i++) {
        const t = i / samplesPerSeg;
        pts.push([x + (x2 - x) * t, y + (y2 - y) * t]);
      }
      x = x2;
      y = y2;
      continue;
    }
    if (c.cmd === "A") {
      const [rx, ry, phiDeg, fa, fs, x2, y2] = c.nums;
      const arc = arcToCenter(x, y, rx, ry, phiDeg, fa, fs, x2, y2);
      for (let i = 1; i <= samplesPerSeg; i++) {
        const t = i / samplesPerSeg;
        const ang = arc.theta1 + arc.dtheta * t;
        const cosAng = Math.cos(ang);
        const sinAng = Math.sin(ang);
        const xp = arc.rx * cosAng;
        const yp = arc.ry * sinAng;
        const cosPhi = Math.cos(arc.phi);
        const sinPhi = Math.sin(arc.phi);
        const xx = arc.cx + cosPhi * xp - sinPhi * yp;
        const yy = arc.cy + sinPhi * xp + cosPhi * yp;
        pts.push([xx, yy]);
      }
      x = x2;
      y = y2;
      continue;
    }
    throw new Error(`Unsupported path command: ${c.cmd}`);
  }
  return pts;
}

function minDistance(aPts, bPts) {
  let best = Infinity;
  for (let i = 0; i < aPts.length; i++) {
    const ax = aPts[i][0];
    const ay = aPts[i][1];
    for (let j = 0; j < bPts.length; j++) {
      const dx = ax - bPts[j][0];
      const dy = ay - bPts[j][1];
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
  }
  return Math.sqrt(best);
}



module.exports={parsePath,arcToCenter,samplePath,minDistance};
