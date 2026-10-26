# Production dependency security updates

- Pinned Ajv to 8.20.0 to resolve GHSA-2g4f-4pwh-qvx6 (`$data` ReDoS).
- Updated Mammoth's compatible transitive `@xmldom/xmldom` lock to 0.8.15, resolving the reported XML injection and parsing time/memory advisories affecting older releases. No forced or major upgrade is used.
- Added a CI production-dependency audit gate. The reviewed Ajv metadata bytes and narrow privacy-audit digest exception remain unchanged.
- Existing CV imports, fake local-model structured responses and release staging are verified against the updated tree. No workspace migration or credential change is required.
