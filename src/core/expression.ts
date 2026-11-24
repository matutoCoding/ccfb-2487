import { BAND_INDEX, type BandName } from '../types';

/**
 * 波段运算表达式编译器
 * 同一 AST 同时生成:
 *  - WGSL 表达式 (GPU 着色器, 波段变量 b0..b4)
 *  - JS 求值函数 (CPU 逐像素参考实现)
 * 两侧除法均为 safeDiv (分母趋零返回 0), 语义严格一致。
 */

export type ASTNode =
  | { kind: 'num'; value: number }
  | { kind: 'band'; band: BandName }
  | { kind: 'unary'; op: '-'; arg: ASTNode }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: ASTNode; right: ASTNode }
  | { kind: 'call'; name: string; args: ASTNode[] };

const FUNCS: Record<string, number> = {
  abs: 1,
  sqrt: 1,
  exp: 1,
  log: 1,
  min: 2,
  max: 2,
  pow: 2,
  clamp: 3,
};

const BAND_SET = new Set<string>(Object.keys(BAND_INDEX));

interface Token {
  type: 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma';
  value: string;
  pos: number;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const s = src;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      // 科学计数法
      if (j < s.length && (s[j] === 'e' || s[j] === 'E')) {
        j++;
        if (s[j] === '+' || s[j] === '-') j++;
        while (j < s.length && /[0-9]/.test(s[j])) j++;
      }
      const value = s.slice(i, j);
      if (!/^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$|^\.[0-9]+([eE][+-]?[0-9]+)?$/.test(value)) {
        throw new ExpressionError(`非法数字 "${value}"`, i);
      }
      tokens.push({ type: 'num', value, pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      tokens.push({ type: 'ident', value: s.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if ('+-*/'.includes(ch)) {
      tokens.push({ type: 'op', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch, pos: i });
      i++;
      continue;
    }
    throw new ExpressionError(`非法字符 "${ch}"`, i);
  }
  return tokens;
}

export class ExpressionError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

class Parser {
  private p = 0;
  constructor(private tokens: Token[]) {}

  parse(): ASTNode {
    const node = this.parseExpr();
    if (this.p < this.tokens.length) {
      throw new ExpressionError(`意外的符号 "${this.tokens[this.p].value}"`, this.tokens[this.p].pos);
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.p];
  }

  private parseExpr(): ASTNode {
    return this.parseAddSub();
  }

  private parseAddSub(): ASTNode {
    let left = this.parseMulDiv();
    while (this.peek()?.type === 'op' && (this.peek()!.value === '+' || this.peek()!.value === '-')) {
      const op = this.tokens[this.p++].value as '+' | '-';
      const right = this.parseMulDiv();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseMulDiv(): ASTNode {
    let left = this.parseUnary();
    while (this.peek()?.type === 'op' && (this.peek()!.value === '*' || this.peek()!.value === '/')) {
      const op = this.tokens[this.p++].value as '*' | '/';
      const right = this.parseUnary();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnary(): ASTNode {
    const t = this.peek();
    if (t?.type === 'op' && t.value === '-') {
      this.p++;
      return { kind: 'unary', op: '-', arg: this.parseUnary() };
    }
    if (t?.type === 'op' && t.value === '+') {
      this.p++;
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ASTNode {
    const t = this.tokens[this.p];
    if (!t) throw new ExpressionError('表达式不完整', 0);
    if (t.type === 'num') {
      this.p++;
      return { kind: 'num', value: Number(t.value) };
    }
    if (t.type === 'ident') {
      this.p++;
      if (BAND_SET.has(t.value)) return { kind: 'band', band: t.value as BandName };
      const next = this.peek();
      if (next?.type === 'lparen') {
        if (!(t.value in FUNCS)) throw new ExpressionError(`未知函数 "${t.value}"`, t.pos);
        this.p++; // consume (
        const args: ASTNode[] = [];
        if (this.peek()?.type !== 'rparen') {
          args.push(this.parseExpr());
          while (this.peek()?.type === 'comma') {
            this.p++;
            args.push(this.parseExpr());
          }
        }
        const close = this.peek();
        if (!close || close.type !== 'rparen') throw new ExpressionError('缺少右括号 ")"', t.pos);
        this.p++;
        if (args.length !== FUNCS[t.value]) {
          throw new ExpressionError(`函数 ${t.value} 需要 ${FUNCS[t.value]} 个参数, 实际 ${args.length} 个`, t.pos);
        }
        return { kind: 'call', name: t.value, args };
      }
      throw new ExpressionError(`未知标识符 "${t.value}" (波段仅支持 B/G/R/RE/NIR)`, t.pos);
    }
    if (t.type === 'lparen') {
      this.p++;
      const node = this.parseExpr();
      const close = this.peek();
      if (!close || close.type !== 'rparen') throw new ExpressionError('缺少右括号 ")"', t.pos);
      this.p++;
      return node;
    }
    throw new ExpressionError(`意外的符号 "${t.value}"`, t.pos);
  }
}

export function parseExpression(src: string): ASTNode {
  const tokens = tokenize(src);
  if (tokens.length === 0) throw new ExpressionError('表达式为空', 0);
  return new Parser(tokens).parse();
}

const EPS = 1e-12;

/** 生成 WGSL 表达式; 波段以 b0..b4 传入, safeDiv 由调用方在着色器中定义 */
export function astToWgsl(node: ASTNode): string {
  switch (node.kind) {
    case 'num':
      return `${node.value}`;
    case 'band':
      return `b${BAND_INDEX[node.band]}`;
    case 'unary':
      return `(-${astToWgsl(node.arg)})`;
    case 'binary':
      if (node.op === '/') return `safeDiv(${astToWgsl(node.left)}, ${astToWgsl(node.right)})`;
      return `(${astToWgsl(node.left)} ${node.op} ${astToWgsl(node.right)})`;
    case 'call':
      return `${node.name}(${node.args.map(astToWgsl).join(', ')})`;
  }
}

/** 生成 CPU 求值函数, 与 WGSL 严格同语义 */
export function astToEvaluator(node: ASTNode): (bands: ArrayLike<number>) => number {
  const ev = (n: ASTNode, b: ArrayLike<number>): number => {
    switch (n.kind) {
      case 'num':
        return n.value;
      case 'band':
        return b[BAND_INDEX[n.band]];
      case 'unary':
        return -ev(n.arg, b);
      case 'binary': {
        const l = ev(n.left, b);
        const r = ev(n.right, b);
        if (n.op === '/') return Math.abs(r) <= EPS ? 0 : l / r;
        return n.op === '+' ? l + r : n.op === '-' ? l - r : l * r;
      }
      case 'call': {
        const a = n.args.map((x) => ev(x, b));
        switch (n.name) {
          case 'abs':
            return Math.abs(a[0]);
          case 'sqrt':
            return Math.sqrt(a[0]);
          case 'exp':
            return Math.exp(a[0]);
          case 'log':
            return Math.log(a[0]);
          case 'min':
            return Math.min(a[0], a[1]);
          case 'max':
            return Math.max(a[0], a[1]);
          case 'pow':
            return Math.pow(a[0], a[1]);
          case 'clamp':
            return Math.min(Math.max(a[0], a[1]), a[2]);
          default:
            throw new ExpressionError(`未知函数 ${n.name}`, 0);
        }
      }
    }
  };
  return (bands) => ev(node, bands);
}

export interface CompiledExpression {
  source: string;
  ast: ASTNode;
  wgsl: string;
  eval: (bands: ArrayLike<number>) => number;
  /** 表达式引用到的波段索引 (用于判断定标/数据依赖) */
  usedBands: number[];
}

export function collectBands(node: ASTNode): number[] {
  const set = new Set<number>();
  const walk = (n: ASTNode) => {
    if (n.kind === 'band') set.add(BAND_INDEX[n.band]);
    else if (n.kind === 'unary') walk(n.arg);
    else if (n.kind === 'binary') {
      walk(n.left);
      walk(n.right);
    } else if (n.kind === 'call') n.args.forEach(walk);
  };
  walk(node);
  return [...set].sort((a, b) => a - b);
}

export function compileExpression(src: string): CompiledExpression {
  const ast = parseExpression(src);
  return {
    source: src,
    ast,
    wgsl: astToWgsl(ast),
    eval: astToEvaluator(ast),
    usedBands: collectBands(ast),
  };
}

export const WGSL_SAFE_DIV = `
fn safeDiv(a: f32, b: f32) -> f32 {
  return select(0.0, a / b, abs(b) > 1e-12);
}`;
