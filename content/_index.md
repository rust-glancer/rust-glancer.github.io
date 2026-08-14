+++
title = "rust-glancer"
sort_by = "date"
template = "index.html"
+++

## About {#about}

[Rust Glancer](https://github.com/rust-glancer/rust-glancer) is a memory efficient LSP for Rust.
It uses a different approach compared to [rust-analyzer](https://rust-analyzer.github.io/): instead of storing everything in memory and recomputing dynamically, it uses frozen workspaces that can be offloaded to the filesystem. As a result, the LSP gets some performance penalty, but is able to achieve extreme memory efficience and instant restarts.

## Quick start {#quick-start}

TODO REPLACE ME quick start

