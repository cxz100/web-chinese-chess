/**
 * Canvas board renderer + input mapping.
 * The board can be flipped (when the local player is Black, their pieces
 * are drawn at the bottom).
 */
import { rc, idx, sideOf, RED } from '/shared/xiangqi.js';

const PIECE_TEXT = {
  K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵',
  k: '将', a: '士', b: '象', n: '马', r: '车', c: '炮', p: '卒',
};

export class BoardView {
  constructor(canvas, onSquareClick) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSquareClick = onSquareClick;
    this.flipped = false;

    this.board = null;
    this.selected = -1;
    this.legalDests = [];
    this.lastMove = null; // { from, to }
    this.checkedKing = -1;

    canvas.addEventListener('pointerdown', (e) => this.handlePointer(e));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  resize() {
    const cssWidth = this.canvas.clientWidth || 480;
    // 9 cols x 10 rows of cells; keep the aspect ratio ~ 9:10 plus margins.
    const cell = cssWidth / 9.6;
    const cssHeight = cell * 10.6;
    const dpr = window.devicePixelRatio || 1;
    this.cell = cell;
    this.marginX = cell * 0.8;
    this.marginY = cell * 0.8;
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  /** Board (row, col) -> canvas (x, y), honouring flip. */
  xy(r, c) {
    const dr = this.flipped ? 9 - r : r;
    const dc = this.flipped ? 8 - c : c;
    return [this.marginX + dc * this.cell, this.marginY + dr * this.cell];
  }

  handlePointer(e) {
    if (!this.onSquareClick) return;
    // Re-sync if the layout changed while callbacks were throttled.
    if (Math.abs((this.canvas.clientWidth || 0) - this.cssWidth) > 1) this.resize();
    const rect = this.canvas.getBoundingClientRect();
    const scale = rect.width > 0 ? this.cssWidth / rect.width : 1;
    const x = (e.clientX - rect.left) * scale;
    const y = (e.clientY - rect.top) * scale;
    let c = Math.round((x - this.marginX) / this.cell);
    let r = Math.round((y - this.marginY) / this.cell);
    if (r < 0 || r > 9 || c < 0 || c > 8) return;
    if (this.flipped) {
      r = 9 - r;
      c = 8 - c;
    }
    this.onSquareClick(idx(r, c));
  }

  setState({ board, selected = -1, legalDests = [], lastMove = null, checkedKing = -1, flipped }) {
    if (board) this.board = board;
    this.selected = selected;
    this.legalDests = legalDests;
    this.lastMove = lastMove;
    this.checkedKing = checkedKing;
    if (typeof flipped === 'boolean') this.flipped = flipped;
    this.draw();
  }

  draw() {
    const { ctx, cell } = this;
    if (!cell) return;
    const w = this.cssWidth;
    const h = this.cssHeight;

    // Wooden background.
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#ecd2a0');
    grad.addColorStop(1, '#dcbc82');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#6b5433';
    ctx.lineWidth = 1.2;

    const [x0, y0] = [this.marginX, this.marginY];
    const x8 = x0 + 8 * cell;
    const y9 = y0 + 9 * cell;
    const y4 = y0 + 4 * cell;
    const y5 = y0 + 5 * cell;

    // Horizontal lines (full width).
    for (let r = 0; r <= 9; r++) {
      const y = y0 + r * cell;
      line(ctx, x0, y, x8, y);
    }
    // Vertical lines: edges run full height, inner columns break at the river.
    for (let c = 0; c <= 8; c++) {
      const x = x0 + c * cell;
      if (c === 0 || c === 8) {
        line(ctx, x, y0, x, y9);
      } else {
        line(ctx, x, y0, x, y4);
        line(ctx, x, y5, x, y9);
      }
    }
    // Outer border (slightly offset, thicker).
    ctx.lineWidth = 2.4;
    ctx.strokeRect(x0 - cell * 0.12, y0 - cell * 0.12, 8 * cell + cell * 0.24, 9 * cell + cell * 0.24);
    ctx.lineWidth = 1.2;

    // Palace diagonals (top rows 0-2, bottom rows 7-9 in *display* coords —
    // the board is symmetric so flipping doesn't change them).
    line(ctx, x0 + 3 * cell, y0, x0 + 5 * cell, y0 + 2 * cell);
    line(ctx, x0 + 5 * cell, y0, x0 + 3 * cell, y0 + 2 * cell);
    line(ctx, x0 + 3 * cell, y0 + 7 * cell, x0 + 5 * cell, y9);
    line(ctx, x0 + 5 * cell, y0 + 7 * cell, x0 + 3 * cell, y9);

    // River text.
    ctx.fillStyle = 'rgba(107, 84, 51, 0.55)';
    ctx.font = `${cell * 0.52}px "KaiTi", "STKaiti", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ry = (y4 + y5) / 2;
    ctx.fillText('楚', x0 + 1.5 * cell, ry);
    ctx.fillText('河', x0 + 2.8 * cell, ry);
    ctx.save();
    ctx.fillText('汉', x0 + 5.2 * cell, ry);
    ctx.fillText('界', x0 + 6.5 * cell, ry);
    ctx.restore();

    // Position markers (cannon and pawn starting points).
    const markers = [
      [2, 1], [2, 7], [7, 1], [7, 7],
      [3, 0], [3, 2], [3, 4], [3, 6], [3, 8],
      [6, 0], [6, 2], [6, 4], [6, 6], [6, 8],
    ];
    for (const [mr, mc] of markers) drawMarker(ctx, x0 + mc * cell, y0 + mr * cell, cell);

    if (!this.board) return;

    // Last move highlight.
    if (this.lastMove) {
      for (const sq of [this.lastMove.from, this.lastMove.to]) {
        const [r, c] = rc(sq);
        const [x, y] = this.xy(r, c);
        ctx.strokeStyle = 'rgba(30, 120, 210, 0.85)';
        ctx.lineWidth = 2;
        drawCornerBox(ctx, x, y, cell * 0.44);
      }
    }

    // Pieces.
    for (let i = 0; i < 90; i++) {
      const p = this.board[i];
      if (!p) continue;
      const [r, c] = rc(i);
      const [x, y] = this.xy(r, c);
      this.drawPiece(x, y, p, i === this.selected, i === this.checkedKing);
    }

    // Legal destinations.
    for (const d of this.legalDests) {
      const [r, c] = rc(d);
      const [x, y] = this.xy(r, c);
      if (this.board[d]) {
        ctx.strokeStyle = 'rgba(46, 160, 67, 0.95)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, cell * 0.44, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(46, 160, 67, 0.85)';
        ctx.beginPath();
        ctx.arc(x, y, cell * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawPiece(x, y, piece, isSelected, isChecked) {
    const { ctx, cell } = this;
    const radius = cell * 0.42;
    const red = sideOf(piece) === RED;

    ctx.save();
    // Shadow.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = red ? '#fdf3dc' : '#f2e8ce';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Rings.
    const color = red ? '#b8351f' : '#20313f';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.84, 0, Math.PI * 2);
    ctx.stroke();

    // Character.
    ctx.fillStyle = color;
    ctx.font = `700 ${cell * 0.46}px "KaiTi", "STKaiti", "SimSun", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(PIECE_TEXT[piece] || '?', x, y + cell * 0.02);

    if (isSelected) {
      ctx.strokeStyle = '#1e78d2';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, radius + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (isChecked) {
      ctx.strokeStyle = '#e02f1f';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(x, y, radius + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** Small corner cross markers at cannon/pawn points. */
function drawMarker(ctx, x, y, cell) {
  const g = cell * 0.08;
  const len = cell * 0.16;
  ctx.strokeStyle = '#6b5433';
  ctx.lineWidth = 1;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const cx = x + sx * g;
    const cy = y + sy * g;
    // Skip marks that would fall outside the board (edge columns).
    if (x + sx * (g + len) < 0 || x + sx * (g + len) > ctx.canvas.clientWidth) continue;
    ctx.beginPath();
    ctx.moveTo(cx + sx * len, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + sy * len);
    ctx.stroke();
  }
}

/** Blue corner brackets marking last-move squares. */
function drawCornerBox(ctx, x, y, half) {
  const seg = half * 0.5;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    ctx.beginPath();
    ctx.moveTo(x + sx * half, y + sy * half - sy * seg);
    ctx.lineTo(x + sx * half, y + sy * half);
    ctx.lineTo(x + sx * half - sx * seg, y + sy * half);
    ctx.stroke();
  }
}
