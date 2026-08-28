# Third-party notices

The Relay preview preload embeds the following open-source software in
`overlay/preview-preload.cjs`.

## markdown-it 14.3.0

Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## DOMPurify 3.4.13

Copyright (c) Cure53 and other contributors.

DOMPurify is distributed under the Apache License 2.0 or the Mozilla Public
License 2.0. Relay distributes its embedded copy under the Apache License 2.0.
The complete terms are included in [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt).

## E2EE runtime libraries (MIT)

The Companion uses the following packages for its RFC 9420 one-to-one text
implementation. Each npm package includes its own complete MIT license text.

- `ts-mls` 1.6.2 — Copyright Luka Jacobowitz and contributors.
- `@hpke/core` 1.8.0 — Copyright hpke-js contributors.
- `@noble/hashes` 2.0.1 — Copyright Paul Miller and contributors.
- `@noble/ciphers` 2.1.1 — Copyright Paul Miller and contributors.
- `@noble/curves` 2.0.1 — Copyright Paul Miller and contributors.

`ts-mls` states that it has not undergone a formal security audit. Relay's own
architecture documentation treats independent cryptographic and application
review as a prerequisite for a public production E2EE claim.

## Go standard library and runtime

The Relay MCP bridge is compiled with the Go toolchain and includes portions of
the Go standard library and runtime. Copyright 2009 The Go Authors. Go is
distributed under a three-clause BSD license; the complete terms are included
in [`licenses/Go.txt`](licenses/Go.txt).
