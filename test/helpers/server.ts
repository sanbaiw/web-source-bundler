import { createServer } from "node:https";
import type { AddressInfo } from "node:net";

type RouteBody = string | Buffer | ((port: number) => string | Buffer);

interface TestRoute {
  status?: number;
  redirect?: string;
  contentType?: string;
  body?: RouteBody;
}

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIURXuOb5CqY9mS0iUdVwAQd5wA8KEwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDYxNzE2Mzk1OFoYDzIxMjYw
NTI0MTYzOTU4WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCjS8wAW2TNJgZSboKRpJG2CGRbKIikv+bUlj4LiDNw
zXHwcNpkyYjV9uyQBtziViyyTeQE6wo3YnxAdh5NcTD8fT84Oq/i0KhQhtRxYlxf
5iNaiXl3wz/Sykwo3IRlScf/4zpBks3RVpon9sYTlG4sbdqot4ZfzRV+8bsfBQuX
vhQ440dDtuDaPIdD90bLF/iWjOSJ+EFLPqjTH1vmeG81nZSwIby4PF1OoDrV1Mze
gWol2UKSOQV6JijbVBC0cTkK/4PkK6MbO9+c/zwUykIb2+i7lG9BAB4wIKoNCuML
VTsRmJXi/oqlJ06P3zyx9Lq++56ny8ErEOLn2MUqSJH5AgMBAAGjZDBiMB0GA1Ud
DgQWBBSrHmphijx31dyyqpUNbTokmaXULTAfBgNVHSMEGDAWgBSrHmphijx31dyy
qpUNbTokmaXULTAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwDQYJ
KoZIhvcNAQELBQADggEBAJ+kEMmQI1+ljvHzJ4j2d790xi02dAHxtjaZiDFJdHPi
wPfHhibgt7QuCQO3fV63xRGWQ0QullhkCOiaZhueGb+I9Ey+dGdYumXuua4XQpS+
XAChQzukIJftLqakM6Cy+FRqWEZFwne+T3eiq4/0vL/uEC3AfCOLahuj7hCE7ocF
8BfJW8NjpOYlcG2xQL9YbtepQKo4C73xybO5ehNE/38lc8mxCb9Z+XMTZR/rwhvs
rK2CUfHfNtDhsDtNYkHutJ0p0D2Mm8awkQYz9NSWRy6GON83UQPPWcF5/Emy1QDe
03xvBkdMagQiHw5+R9s79EWVtQamPcOsPtEQ5JR+J8k=
-----END CERTIFICATE-----`;

const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCjS8wAW2TNJgZS
boKRpJG2CGRbKIikv+bUlj4LiDNwzXHwcNpkyYjV9uyQBtziViyyTeQE6wo3YnxA
dh5NcTD8fT84Oq/i0KhQhtRxYlxf5iNaiXl3wz/Sykwo3IRlScf/4zpBks3RVpon
9sYTlG4sbdqot4ZfzRV+8bsfBQuXvhQ440dDtuDaPIdD90bLF/iWjOSJ+EFLPqjT
H1vmeG81nZSwIby4PF1OoDrV1MzegWol2UKSOQV6JijbVBC0cTkK/4PkK6MbO9+c
/zwUykIb2+i7lG9BAB4wIKoNCuMLVTsRmJXi/oqlJ06P3zyx9Lq++56ny8ErEOLn
2MUqSJH5AgMBAAECggEAOui8swJFhpapoDI6y0TVxhgX8CTayqhqIxYCUxGzEQYk
jQuBVeu4gAvgwoKfS82vuTFNSZLrMBjI305dVy228NdUJ7pQOmBw4AAMAs1rqrLw
3RgMKG7ZBvew6urGnm20B3WXThGiS1tVKIanZWfeKQwGXmg6wzPOhem5yhJ9YKN/
GQNuX5q4Ouim2O2CS6XPrSWEXcxgK+XwrzB9c2vfeF9itpHjZv9jqRHupmQNLmRD
iHoUGQ73vOX5KR/wtEs9Fir75wQMviLw/BFT7S6CrJAD//g4VZzoiSKPL/7LvejV
7u7GfI4hg/XDiYYwSy28xePl7MYet8jYSbkk14cYgwKBgQDhehuFrk9kRH6Apyrm
l+wuhumDrvEvpqxwlFtmM2ZMFwAV7SSMfywZZr9a1id0rPmmnZe+fq4/VbaJzFrq
uBOkMO/+EzYrWIBhy8UDv5g7d2CC4dKq3kiydIWslD/XAggj7E923vGdKuFDvknW
RZsSFTUGJDScVIhVz/zqBN7kVwKBgQC5ZtBLlea9Fe+OOJImxEZ+MglZujSYa8AQ
e8d0pyEoH/cA6KcpGW6R1GG1hcd6HNgXgYDkIpTXPbpUA6bJkQ+konKN8VA1bpd8
uTwVICZhzWNTndJfua25CH0CagpNJ0hs3iCgHpEgG7GbczRk9oD5xidr3lVoTt0j
bCOTBlDKLwKBgCuTp+IMMDfWrQQ8SqRKVFEhrdvPYbmt4sHXSlrUMD8gatnR/TBS
G7nFC9KIdROtooo7BurAHPkMnbzADAo1DUa8VoWqPNvfvOApu6ffzZIgnjxtXIO9
dhtXPcZ+2F+7estGjo0QxW10rhijnC2XQkMaaicHtEtKYxcCnYS08Eb9AoGAG5Rc
xfGtmlEqCpkFvLiT1+/vjiZx7n6Q2qLfH85A02w13S++thFvbkgOpOcarmKeDpkY
KFewlng7QIYuiGuIzS/RJKZSDTC/XjFb67SVoRThgq3GfrDrU8wcdIB7udBvKKq+
ZbNGWWVlPT+c+qvkscM1WAmB4PtiUAOlIxjcaccCgYEAyBvTEGBqkZuNuFlYfP/f
pxR6wsprWu7YFD+5Uz0Vv/LiRGo+gKV9MS2MmXoZj8iTV1eXQaT177aMp96AJ2gy
UfSLp2SpCSyLt6dZnsqHtbwjxtSbnTersDJzVISipijoD268u9bw0b48+zVZc0BR
Riu1Sv8wC1+nvt8auYC9x/s=
-----END PRIVATE KEY-----`;

function serverPort(address: string | AddressInfo | null): number {
  if (!address || typeof address === "string") {
    throw new Error("Expected server to listen on a TCP port");
  }
  return address.port;
}

function routeBody(route: TestRoute, port: number): string | Buffer {
  if (typeof route.body === "function") {
    return route.body(port);
  }
  return route.body ?? "";
}

export async function withServer(
  routes: Record<string, TestRoute>,
  fn: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    const route = routes[req.url || "/"];
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    if (route.redirect) {
      res.writeHead(route.status || 302, { location: route.redirect });
      res.end();
      return;
    }

    const port = serverPort(server.address());
    res.writeHead(route.status || 200, {
      "content-type": route.contentType || "text/plain",
    });
    res.end(routeBody(route, port));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    await fn(`https://127.0.0.1:${serverPort(server.address())}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

export async function withAnyLoopbackServer(
  routes: Record<string, TestRoute>,
  fn: (origins: {
    sourceOrigin: string;
    referenceOrigin: string;
  }) => Promise<void>,
): Promise<void> {
  const server = createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    const route = routes[req.url || "/"];
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    const port = serverPort(server.address());
    res.writeHead(route.status || 200, {
      "content-type": route.contentType || "text/plain",
    });
    res.end(routeBody(route, port));
  });

  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = serverPort(server.address());

  try {
    await fn({
      sourceOrigin: `https://127.0.0.1:${port}`,
      referenceOrigin: `https://0.0.0.0:${port}`,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
