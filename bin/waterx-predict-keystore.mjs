#!/usr/bin/env node
// The keystore signer's binary of a git install (ADR-0019). Same key handling
// as the standalone artifact: the key stays in this process and nowhere else.
import './../dist/install/keystore/bin/keystore.js';
