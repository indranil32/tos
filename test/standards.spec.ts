import { parseEdifact, writeEdifact, el } from '../src/edi/edifact';
import { iso6346CheckDigit, isValidContainerNumber, isValidIsoType, isValidVin, teuFromIsoType } from '../src/inventory/standards';

describe('ISO 6346 container numbers', () => {
  it('computes the check digit (reference example CSQU305438-3)', () => {
    expect(iso6346CheckDigit('CSQU305438')).toBe(3);
    expect(isValidContainerNumber('CSQU3054383')).toBe(true);
  });
  it('rejects a wrong check digit, bad category and bad shape', () => {
    expect(isValidContainerNumber('CSQU3054384')).toBe(false);
    expect(isValidContainerNumber('CSQX3054383')).toBe(false);
    expect(isValidContainerNumber('CSQU305438')).toBe(false);
  });
  it('validates size/type codes and TEU', () => {
    expect(isValidIsoType('22G1')).toBe(true);
    expect(isValidIsoType('45G1')).toBe(true);
    expect(isValidIsoType('L5G1')).toBe(true);
    expect(isValidIsoType('2')).toBe(false);
    expect(teuFromIsoType('22G1')).toBe(1);
    expect(teuFromIsoType('45R1')).toBe(2);
    expect(teuFromIsoType('L5G1')).toBe(2);
  });
});

describe('ISO 3779 VIN', () => {
  it('accepts 17 characters without I, O, Q', () => {
    expect(isValidVin('WVWZZZ1JZXW000001')).toBe(true);
    expect(isValidVin('WVWZZZ1JZXW00000I')).toBe(false);
    expect(isValidVin('SHORT')).toBe(false);
  });
});

describe('EDIFACT syntax', () => {
  it('parses UNA, release characters and line breaks', () => {
    const segs = parseEdifact("UNA:+.? 'UNB+UNOA:2+SENDER+RECV'\nFTX+AAI+++It?'s 50?+ tons?: ok'\r\nUNZ+1+X'");
    expect(segs.map((s) => s.tag)).toEqual(['UNB', 'FTX', 'UNZ']);
    expect(el(segs[0], 1, 1)).toBe('2');
    expect(el(segs[1], 4)).toBe("It's 50+ tons: ok");
  });
  it('round-trips through the writer with escaping', () => {
    const text = writeEdifact([['FTX', 'AAI', '', '', "Bob's +1: note"]] as any);
    expect(text).toBe("FTX+AAI+++Bob?'s ?+1?: note'");
    expect(el(parseEdifact(text)[0], 4)).toBe("Bob's +1: note");
  });
  it('fails on an unterminated message', () => {
    expect(() => parseEdifact('UNB+UNOA:2')).toThrow();
  });
});
