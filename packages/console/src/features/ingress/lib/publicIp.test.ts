import { describe, expect, it } from 'vitest';
import { dnsRecordType } from './publicIp';

describe('dnsRecordType', () => {
  it('labels an IPv4 address as an A record', () => {
    expect(dnsRecordType('203.0.113.10')).toBe('A');
  });

  it('labels an IPv6 address as an AAAA record, not A', () => {
    expect(dnsRecordType('2001:db8::10')).toBe('AAAA');
  });

  it('labels a full-form IPv6 address as AAAA too', () => {
    expect(dnsRecordType('2001:0db8:0000:0000:0000:0000:0000:0010')).toBe(
      'AAAA',
    );
  });
});
