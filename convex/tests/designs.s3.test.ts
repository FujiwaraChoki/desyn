import { describe, expect, test } from "vitest";
import {
  objectLocation,
  presignLocation,
  presignUrl,
  type S3Config,
  signedRequestHeaders,
  windowStart,
} from "../lib/designs_s3";

// AWS Signature V4 test vectors from the Amazon S3 API reference ("Authenticating Requests: Using Query
// Parameters" and "Using the Authorization Header" examples).
const EXAMPLE = {
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const DATE = new Date(Date.UTC(2013, 4, 24, 0, 0, 0));

describe("SigV4", () => {
  test("presigned GET matches the AWS documentation example", () => {
    const url = presignLocation(
      EXAMPLE,
      { protocol: "https:", host: "examplebucket.s3.amazonaws.com", path: "/test.txt" },
      { method: "GET", expiresIn: 86400, date: DATE },
    );
    expect(url).toContain(
      "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    expect(url).toContain(
      "X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request",
    );
    expect(url).toContain("X-Amz-SignedHeaders=host");
  });

  test("header-signed GET with Range matches the AWS documentation example", () => {
    const headers = signedRequestHeaders(EXAMPLE, {
      method: "GET",
      location: { protocol: "https:", host: "examplebucket.s3.amazonaws.com", path: "/test.txt" },
      headers: { range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      date: DATE,
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  test("locations for AWS, MinIO (path style) and R2", () => {
    const aws: S3Config = { ...EXAMPLE, bucket: "desyn", forcePathStyle: false };
    expect(objectLocation(aws, "uploads/a b/ü.png")).toEqual({
      protocol: "https:",
      host: "desyn.s3.us-east-1.amazonaws.com",
      path: "/uploads/a%20b/%C3%BC.png",
    });
    const minio: S3Config = { ...aws, endpoint: "http://localhost:9000", forcePathStyle: true };
    expect(objectLocation(minio, "k")).toEqual({
      protocol: "http:",
      host: "localhost:9000",
      path: "/desyn/k",
    });
    const r2: S3Config = {
      ...aws,
      region: "auto",
      endpoint: "https://acc.r2.cloudflarestorage.com",
    };
    expect(objectLocation(r2, "k").host).toBe("desyn.acc.r2.cloudflarestorage.com");
    const dotted: S3Config = { ...aws, bucket: "my.bucket" };
    expect(objectLocation(dotted, "k").path).toBe("/my.bucket/k");
  });

  test("upload URLs sign content-type and content-length; GET URLs are stable within a window", () => {
    const cfg: S3Config = {
      ...EXAMPLE,
      bucket: "desyn",
      endpoint: "http://localhost:9000",
      forcePathStyle: true,
    };
    const put = new URL(
      presignUrl(cfg, "uploads/x.png", {
        method: "PUT",
        expiresIn: 900,
        signedHeaders: { "content-type": "image/png", "content-length": "42" },
      }),
    );
    expect(put.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(put.searchParams.get("X-Amz-Expires")).toBe("900");
    const t0 = Date.UTC(2026, 0, 1, 10, 5);
    const a = presignUrl(cfg, "k", { method: "GET", expiresIn: 7200, date: windowStart(t0, 3600) });
    const b = presignUrl(cfg, "k", {
      method: "GET",
      expiresIn: 7200,
      date: windowStart(t0 + 40 * 60_000, 3600),
    });
    const c = presignUrl(cfg, "k", {
      method: "GET",
      expiresIn: 7200,
      date: windowStart(t0 + 60 * 60_000, 3600),
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
