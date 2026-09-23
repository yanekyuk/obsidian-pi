# Semantic search: a possible next step

Status: not built. This note records the design so it can be picked up later. It builds on `obsidian_search` (`src/search/`), which ranks sections by the words they share with the query.

## The gap it would close

Word search can't find a note that says the same thing in other words. "burnout" doesn't find "I was exhausted all spring", and "pricing" doesn't find "what we charge". In code, exact identifiers make grep good enough. Notes are prose, so these misses are common. Today pi works around them by searching again with synonyms. A semantic index finds these notes by meaning.

## Shape

**Same tool, better ranking.** `obsidian_search` keeps its parameters and output. `SearchIndex` gains a second ranking over the same sections, and the two lists are merged with reciprocal rank fusion: each section scores the sum of `1 / (60 + rank)` over both lists. The link boost and related notes apply afterwards, as now. pi doesn't need to know which ranking found a section, and exact words (names, codes, tags) still win through BM25.

**Sections are embedded with their context.** A section is embedded as `title › heading › heading` followed by its text, so a short section under "Pricing" still knows what it is about. The sections are the ones `SearchIndex` already cuts (headings, then blank lines at about 2000 characters). They fit the input limits of small embedding models.

**Kept current the same way.** `VaultSearch` already receives every change, rename and delete. For embeddings, a changed note is re-embedded only for the sections whose text hash changed. The work runs in a background queue that waits a few seconds after typing stops. A search while the queue is not empty uses whatever vectors are ready, and BM25 still covers the rest.

## Where the embeddings come from

In order of preference:

1. **Ollama, if it is running** (`POST http://localhost:11434/api/embed`). Nothing to bundle, and the user picks the model. Good defaults are `embeddinggemma` (300M parameters, 768 dimensions) or `qwen3-embedding:0.6b` (1024 dimensions). Both are small, multilingual and run on a laptop CPU.
2. **In process, downloaded on first use.** transformers.js with an ONNX build of one of those models, on WebGPU where Electron offers it. Obsidian installs only `main.js`, `manifest.json` and `styles.css`, so the runtime and the model (a few hundred MB) would have to be fetched into the plugin folder after an explicit opt-in. Heavier to maintain than option 1.
3. **Smart Connections' embeddings, if that plugin is installed.** It keeps them in the vault's `.smart-env` folder. There is no second index to build, but the plugin would depend on another plugin's private file format.
4. **A cloud embedding API, opt-in only.** It would send the whole vault to a provider, which contradicts what the README promises about note content. Only on explicit request.

Whatever the source, the index records the model id. A different model means embedding everything again.

## Storage and search cost

- **Size.** Both models support Matryoshka truncation: the first 256 dimensions of a vector are nearly as good as all of them. Truncated to 256 dimensions and quantised to int8, 25,000 sections take about 6.4 MB.
- **Storage.** One binary file in the plugin folder, plus a small JSON manifest (model id, dimensions, per-section path, line range and text hash).
- **Search.** Brute-force dot products over 25,000 × 256 values take milliseconds. No vector database is needed below roughly 100,000 sections.
- **Query cost.** The query itself has to be embedded, one model call per search. That is quick locally, and it is the only added latency.

## Settings

- **Semantic search:** off by default. When on, choose Ollama with its model name, or the downloaded model.
- **Progress:** first indexing shows progress in the status bar ("Embedding notes: 1,240 / 5,300"). It can be paused and resumes after a restart, because the file on disk is updated as it goes.

## Before shipping

- **Measure first.** Collect 30–50 real questions about one's own vault, each with the note that answers it. Compare recall@8 of BM25 alone against the hybrid. Build it only if the hybrid is clearly better on those questions.
- **Measure indexing speed** on CPU for each backend, and set the queue's pace from that.
- **Maybe later, a reranker** (for example Qwen3-Reranker-0.6B) over the top 30 fused results. It costs one more model call per search. Add it only if the measurement shows ordering, not recall, is the problem.
