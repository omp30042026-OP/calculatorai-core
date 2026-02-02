## Veritascale CLI: seal + verify demo

### One-time (generate local keys)
npm run vs:keygen

### Demo mode A (embed public key in the signature)
npm run vs:demo:embed

### Demo mode B (no embedded pubkey; verify uses --pubkey override)
npm run vs:demo:prod

### Cleanup local artifacts
npm run vs:clean
