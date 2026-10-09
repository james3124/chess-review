/* board.js — dependency-free SVG chessboard (Unicode pieces, no image assets) */

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const GLYPH = { k: '\u265A', q: '\u265B', r: '\u265C', b: '\u265D', n: '\u265E', p: '\u265F' };
const S = 100; // square size

/** FEN -> [{ square: 'e4', piece: 'wP' }] */
function piecesOf(fen) {
  const out = [];
  const rows = fen.split(' ')[0].split('/');
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      const isWhite = ch === ch.toUpperCase();
      out.push({ file: f, rank: 7 - r, piece: (isWhite ? 'w' : 'b') + ch.toLowerCase() });
      f += 1;
    }
  });
  return out;
}

export class Board {
  constructor(svg) {
    this.svg = svg;
    this.flip = false;
    this.last = null;
    this.arrows = [];
  }

  /** @param {string} fen @param {{lastMove?:string,arrows?:Array,check?:boolean}} o */
  setPosition(fen, o = {}) {
    this.last = o.lastMove || null;
    this.arrows = o.arrows || [];
    const check = o.check;

    let s = `<rect width="800" height="800" fill="${'#739552'}"></rect>`;
    for (let f = 0; f < 8; f++) {
      for (let r = 0; r < 8; r++) {
        const x = f * S, y = (7 - r) * S;
        const light = (f + r) % 2 === 1;
        s += `<rect x="${x}" y="${y}" width="${S}" height="${S}" fill="${light ? '#ebecd0' : '#779556'}"></rect>`;
      }
    }

    // last move highlight
    if (this.last) {
      const [a, b] = [this.last.slice(0, 2), this.last.slice(2, 4)];
      for (const sq of [a, b]) {
        const { x, y } = this.squareXy(sq);
        s += `<rect x="${x}" y="${y}" width="${S}" height="${S}" fill="#f7f769" opacity="0.34"></rect>`;
      }
    }

    // arrows (best move, blunder)
    for (const ar of this.arrows) s += this.arrow(ar);

    // coordinates (drawn under pieces, inside the squares)
    for (let f = 0; f < 8; f++) {
      const sx = (this.flip ? 7 - f : f) * S;
      const fileTop = (this.flip ? 7 : 0) === 7 ? 0 : 7;
      s += `<text class="coord" x="${sx + S - 9}" y="${fileTop === 7 ? S - 10 : 790}" text-anchor="end">${FILES[f]}</text>`;
    }
    for (let r = 0; r < 8; r++) {
      const sy = (this.flip ? r : 7 - r) * S;
      s += `<text class="coord" x="${this.flip ? 91 : 9}" y="${sy + 22}">${r + 1}</text>`;
    }

    // pieces
    for (const p of piecesOf(fen)) {
      const { x, y } = this.squareXyIndex(p.file, p.rank);
      const cls = p.piece[0] === 'w' ? 'w' : 'b';
      s += `<text class="piece ${cls}" x="${x + S / 2}" y="${y + S / 2}">${GLYPH[p.piece[1]]}</text>`;
    }

    // check highlight (square ring of the king in check)
    if (check) {
      for (const p of piecesOf(fen)) {
        if (p.piece !== this._kingColor(fen) + 'k') continue;
        const { x, y } = this.squareXyIndex(p.file, p.rank);
        s += `<rect x="${x + 4}" y="${y + 4}" width="${S - 8}" height="${S - 8}" rx="10"
                fill="none" stroke="#e03030" stroke-width="7"></rect>`;
        break;
      }
    }

    this.svg.innerHTML = s;
  }

  _kingColor(fen) { return fen.split(' ')[1] === 'w' ? 'w' : 'b'; }

  /** 'e4' -> {x,y} top-left of that square */
  squareXy(sq) {
    const f = FILES.indexOf(sq[0]);
    const r = Number(sq[1]) - 1;
    return this.squareXyIndex(f, r);
  }

  squareXyIndex(f, r) {
    const x = (this.flip ? 7 - f : f) * S;
    const y = (this.flip ? r : 7 - r) * S;
    return { x, y };
  }

  arrow({ from, to, color, width = 17 }) {
    const a = this.squareXy(from), b = this.squareXy(to);
    const x1 = a.x + S / 2, y1 = a.y + S / 2;
    const x2 = b.x + S / 2, y2 = b.y + S / 2;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const sx = x1 + ux * 26, sy = y1 + uy * 26;
    const ex = x2 - ux * 34, ey = y2 - uy * 34;
    const ang = Math.atan2(uy, ux);
    const head = 20;
    const p1 = [ex + ux * head, ey + uy * head];
    const p2 = [ex - uy * head * 0.55, ey + ux * head * 0.55];
    const p3 = [ex + uy * head * 0.55, ey - ux * head * 0.55];
    return `<g opacity="0.85">
      <line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-width="${width}"
            stroke-linecap="round"></line>
      <polygon points="${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${p3[0]},${p3[1]}" fill="${color}"></polygon>
    </g>`;
  }

  toggleFlip() { this.flip = !this.flip; return this.flip; }
}
