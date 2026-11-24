import { describe, it, expect } from 'vitest';
import { compileExpression, ExpressionError } from '../src/core/expression';

describe('表达式编译器', () => {
  it('内置指数数值正确', () => {
    const ndvi = compileExpression('(NIR - R) / (NIR + R)');
    // B,G,R,RE,NIR
    expect(ndvi.eval([0.05, 0.1, 0.06, 0.25, 0.5])).toBeCloseTo((0.5 - 0.06) / 0.56, 10);
    const ndre = compileExpression('(NIR - RE) / (NIR + RE)');
    expect(ndre.eval([0, 0, 0, 0.3, 0.5])).toBeCloseTo(0.25, 10);
    const gndvi = compileExpression('(NIR - G) / (NIR + G)');
    expect(gndvi.eval([0, 0.12, 0, 0, 0.48])).toBeCloseTo(0.36 / 0.6, 10);
  });

  it('除零安全返回 0 而不是 NaN/Infinity', () => {
    const e = compileExpression('NIR / R');
    expect(e.eval([0, 0, 0, 0, 0.5])).toBe(0);
  });

  it('WGSL 输出包含 safeDiv 与波段变量', () => {
    const e = compileExpression('2.5 * (NIR - R) / (NIR + 6*R - 7.5*B + 1)');
    expect(e.wgsl).toContain('safeDiv');
    expect(e.wgsl).toContain('b4');
    expect(e.wgsl).toContain('b2');
  });

  it('支持函数调用与一元负号', () => {
    const e = compileExpression('max(0, sqrt(NIR)) - min(R, 0.5) + -G');
    const v = e.eval([0, 0.09, 0.04, 0, 0.36]);
    expect(v).toBeCloseTo(0.6 - 0.04 - 0.09, 10);
  });

  it('收集引用波段', () => {
    expect(compileExpression('(NIR - R) / (NIR + R)').usedBands).toEqual([2, 4]);
  });

  it('非法表达式抛错并带位置', () => {
    expect(() => compileExpression('NIR +')).toThrow(ExpressionError);
    expect(() => compileExpression('NIR @ R')).toThrow(ExpressionError);
    expect(() => compileExpression('foo(B)')).toThrow(ExpressionError);
    expect(() => compileExpression('(NIR - R')).toThrow(ExpressionError);
  });

  it('幂等: 同一表达式编译结果确定性', () => {
    const a = compileExpression('(NIR-R)/(NIR+R)');
    const b = compileExpression('(NIR-R)/(NIR+R)');
    expect(a.wgsl).toBe(b.wgsl);
  });
});
