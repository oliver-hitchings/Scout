# Namespaced model assessment history

Scan receipts now retain valid namespaced model identifiers in assessment provenance. Changing such a model can reassess earlier rejections under the existing per-scan limit; unchanged models continue to skip unchanged rejections.

The model field uses Scout's shared bounded identifier contract. Other identifier fields retain their existing restrictions. Existing history is not rewritten, and records without assessment provenance remain legacy evidence. No configuration migration is required.
