// A self-signed TLS certificate for 127.0.0.1, made in memory for the page fixture's https server
// (page-fixture.ts). It is built with Node's own crypto rather than the openssl command, so the
// tests need no system tool, and they behave the same with the OpenSSL that Linux ships and the
// LibreSSL that macOS ships, which take different options.
//
// The certificate is encoded here in DER, the binary form of X.509 (RFC 5280), from a handful of
// ASN.1 types. It is an authority for itself (basic constraints CA:TRUE), so the process can
// trust it directly, and it is also the server's certificate, for the address 127.0.0.1 and the
// name localhost. Its key is an ECDSA P-256 key, and it is valid from an hour ago for a day.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

/** A private key and its certificate, both in PEM, as `https.createServer` takes them. */
export interface TestCertificate {
  readonly key: string;
  readonly cert: string;
}

// The length octets of a DER value: one byte up to 127, otherwise a count of bytes, then the
// bytes, most significant first.
function lengthOctets(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) {
    bytes.unshift(rest & 0xff);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), lengthOctets(body.length), body]);
}

const sequence = (...contents: Buffer[]) => tlv(0x30, ...contents);
const set = (...contents: Buffer[]) => tlv(0x31, ...contents);
const octetString = (contents: Buffer) => tlv(0x04, contents);
const utf8String = (text: string) => tlv(0x0c, Buffer.from(text, "utf8"));
const booleanTrue = () => tlv(0x01, Buffer.from([0xff]));
// A context-specific tag: EXPLICIT wraps a whole value, and the IMPLICIT ones in a subject
// alternative name replace a string's own tag.
const explicit = (number: number, contents: Buffer) => tlv(0xa0 + number, contents);
const implicit = (number: number, contents: Buffer) => tlv(0x80 + number, contents);

/** A BIT STRING whose last `unusedBits` bits are padding. */
function bitString(contents: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.from([unusedBits]), contents);
}

/** A non-negative INTEGER from big-endian bytes, with a leading zero when the top bit is set. */
function integer(bytes: Buffer): Buffer {
  const first = bytes[0] ?? 0;
  return tlv(0x02, first >= 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

/** An OBJECT IDENTIFIER: the first two arcs in one byte, then each arc in base 128. */
function objectIdentifier(dotted: string): Buffer {
  const [first = 0, second = 0, ...arcs] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const arc of arcs) {
    const groups = [arc & 0x7f];
    for (let rest = arc >> 7; rest > 0; rest >>= 7) {
      groups.unshift((rest & 0x7f) | 0x80);
    }
    bytes.push(...groups);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** A UTCTime, YYMMDDHHMMSSZ, which RFC 5280 requires for dates before 2050. */
function utcTime(date: Date): Buffer {
  const text = date.toISOString().replace(/[-:T]/g, "").slice(2, 14);
  return tlv(0x17, Buffer.from(`${text}Z`, "ascii"));
}

// A name with only a common name.
const commonName = (name: string) =>
  sequence(set(sequence(objectIdentifier("2.5.4.3"), utf8String(name))));

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical
    ? sequence(objectIdentifier(id), booleanTrue(), octetString(value))
    : sequence(objectIdentifier(id), octetString(value));
}

const ECDSA_WITH_SHA256 = sequence(objectIdentifier("1.2.840.10045.4.3.2"));

/** Makes a self-signed certificate for 127.0.0.1 and localhost. */
export function makeTestCertificate(): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const name = commonName("Haystack page fixture");
  const now = Date.now();
  const serial = randomBytes(8);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const extensions = sequence(
    // basicConstraints: an authority, so it can be its own trust anchor.
    extension("2.5.29.19", true, sequence(booleanTrue())),
    // keyUsage: digitalSignature (bit 0) and keyCertSign (bit 5), so 0b10000100 with two unused
    // bits at the end.
    extension("2.5.29.15", true, bitString(Buffer.from([0x84]), 2)),
    // extendedKeyUsage: serverAuth.
    extension("2.5.29.37", false, sequence(objectIdentifier("1.3.6.1.5.5.7.3.1"))),
    // subjectAltName: the IP address 127.0.0.1 ([7]) and the DNS name localhost ([2]).
    extension(
      "2.5.29.17",
      false,
      sequence(implicit(7, Buffer.from([127, 0, 0, 1])), implicit(2, Buffer.from("localhost"))),
    ),
  );
  const toBeSigned = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_WITH_SHA256,
    name,
    sequence(utcTime(new Date(now - 60 * 60 * 1000)), utcTime(new Date(now + 24 * 60 * 60 * 1000))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, extensions),
  );
  // For an EC key, sign gives the DER-encoded ECDSA signature that X.509 expects.
  const signature = sign("sha256", toBeSigned, privateKey);
  const der = sequence(toBeSigned, ECDSA_WITH_SHA256, bitString(signature));
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
  };
}
