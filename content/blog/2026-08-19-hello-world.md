+++
title = "Hello, world!"
date = 2026-08-19
description = "Rust Glancer announcement post"
+++

I want to present a project that I've been working on for the past 4 months: an alternative Rust LSP implementation that is built with a focus on low memory usage.

It has two main features:
- It can use very little memory (target <100mb for reasonable projects). There are caveats, these are described below.
- It allows immediate indexing after restart: if your project was indexed, restarting the editor will not require re-indexing.

<video controls playsinline preload="metadata" width="1512" height="950">
  <source src="/assets/2026-08-19-hello-world/recording.mp4" type="video/mp4">
  Your browser does not support embedded videos. You can
  <a href="/assets/2026-08-19-hello-world/recording.mp4">download the recording</a> instead.
</video>

*Note: throughout this video, the used RAM remained under 100mb*

![Rust Glancer memory usage remaining below 100 MB](/assets/2026-08-19-hello-world/memory.png)

These features make Rust Glancer suitable for the older computers: I have tested it on my old MacBook Pro M1 2020 with 8GB RAM, and it was pretty good.

| Machine | LSP | Base indexing (engine usable) | Full indexing |
| --- | --- | ---: | ---: |
| MacBook Pro M4 Max, 36GB (2025) | Rust Glancer | 5 seconds | 8 seconds |
| MacBook Pro M4 Max, 36GB (2025) | rust-analyzer | 6 seconds | 13 seconds |
| MacBook Pro M1, 8GB (2020) | Rust Glancer | 6 seconds | 9 seconds |
| MacBook Pro M1, 8GB (2020) | rust-analyzer | 7 seconds | 14 seconds |

As you can imagine, 4 months is not a lot of time for a project as big as a Rust LSP. Rust Glancer is not a complete LSP yet, it has a lot of missing functionality, it has some known bugs, and it has a lot of things I want to improve.

At the same time, it is already pretty capable: it has a full indexing pipeline with type inference and a trait solver (chalk), most of the "normal" Rust syntax is supported, and most of the "normal" LSP actions do work as well: goto definition, hover, inlay hints, completions, you name it.

If you are interested, you can already try it out: just install the VS Code extension [here](https://marketplace.visualstudio.com/items?itemName=rust-glancer.rust-glancer), or, if you prefer, build and install the vsix from the [repository](https://github.com/rust-glancer/rust-glancer/).

The rest of the post contains the history of the project: motivation, LLM use, plans and roadmap. If you're not interested, you might want to check out the [project documentation](https://rust-glancer.github.io/docs) instead.

## Difference with rust-analyzer

There are several reasons why rust-analyzer consumes a lot of memory:
1. Rust workspaces genuinely have a lot of information that must be indexed: thousands of functions, structures, traits, relationships between these, function bodies and statements in them, etc. Each of these needs to be analyzed and remembered, and you can't really cheat if you want to have things like "find all references to this structure".
2. rust-analyzer uses [salsa](https://salsa-rs.github.io/salsa/) as its database. It's an incremental query-based database, which lazily computes all the data you need without having to explicitly "record" everything. It is a very cool approach, but it's inherently tied to memory, which makes it hard to move parts of data from memory elsewhere.
3. rust-analyzer uses [rowan](https://github.com/rust-analyzer/rowan) for syntax tree representation. The cool property here is that it allows partial invalidation: if only a part of the file changed, only the relevant bits have to be reparsed, which makes it faster than having to re-parse the whole file on each keystroke. However, the tree-like representation inside of it can cause heavy memory fragmentation (meaning that the amount of RAM taken from the OS is higher than the amount of "actually used" RAM).

(1) is something we have to live with (though there are a few optimizations we can do there which Rust Glancer does), but (2) and (3) are the consequences of the rust-analyzer architecture. rust-analyzer chose them to make the LSP faster, and it does work for that purpose.

The idea I had when I started the project: what if we _don't_ try to make an incremental LSP? What if all we have is a frozen analysis result that gets invalidated on save? It obviously will not be as fast as rust-analyzer, but it will give us the properties we seek:
1. analysis results can be offloaded to the filesystem and loaded to memory only when they are actually needed.
2. saved analysis is reusable, and since it's already offloaded to the filesystem, it can be reused after the editor restart.

This is the core idea of Rust Glancer.

It indexes the workspace once and preserves results in the filesystem, and then whenever queries need something, they can load the required information for the duration of the query.

It doesn't come for free though: frozen workspace analysis is slower than lazy incremental by definition, since loading and deserializing data from filesystem is slower than loading from memory. To mitigate that, Rust Glancer has to use some tricks: for example, when you type, it doesn't perform full blown analysis on each keystroke, it instead attempts shallow analysis of the current body and reuses the _previous_ complete index. This makes completions reasonably fast, but it also means that new items (imports, structures, traits) are not "indexed" until you save the document. Which, hopefully, should not be a problem: you really get used to it fast, and at least in my case it does not feel overly wrong after a while. If that sounds scary, I suggest to just try it, it really is not.

For people who rely on agentic workflows, Rust Glancer is also optimized for large amount of out-of-editor changes. I'm not sure why, but in rust-analyzer I've observed that when agents edit the code, inlay hints can get out of place, and I had the same problem in Rust Glancer initially, but it was resolved by implementing a custom file watcher and tweaking it somewhat. The server also has lower priority for out-of-editor changes, so agentic changes do not cause rapid re-indexing.

Still, it's important to understand that Rust Glancer has some benefits, but also has some drawbacks (besides being incomplete, obviously) compared to rust-analyzer. Maybe I will manage to solve some of them eventually, but it's highly unlikely that Rust Glancer will ever become "just like rust-analyzer, but better". I imagine that rust-analyzer will remain the default choice for projects that care about completeness and keystroke accuracy, while Rust Glancer will work for people with weaker machines _or_ people who are ready for some sacrifices to reduce RAM usage.

## How and why it happened

I have been writing Rust professionally for ~7 years, and since pretty early on I started observing how the compiler and its tooling are developed. I've made some contributions to rustc, clippy, and rust-analyzer, and I've spent dozens of hours reading its source code just to teach myself. So I was pretty much aware _how big_ of a project a Rust LSP is.

At the same time, I have a love-hate relationship with rust-analyzer. It is absolutely beautiful except for two things: memory usage and initial indexing (especially with build scripts / proc macros enabled). These problems seem to be brought up quite a lot, but in my case they are even more drastic: I have a rather stupid workflow where I have two identical IDEs open on two displays with a bunch of projects inside a workspace. So the memory consumption is roughly 2N, and with my last set of the projects I had to work on, rust analyzer was consuming 16GB of memory that I, ugh, would prefer to have available for other uses; not to mention that each time I opened VS Code, my PC fans would go brr because of a ton of parallel indexing jobs.

At some point I thought that I am fairly confident in my Rust knowledge, so I probably don't need a full-blown LSP, and can use something simpler and more memory efficient. I decided to try building a "smart ctags for Rust". I very explicitly did not want to build an alternative LSP, because of how insane of a task it is. Little did I know...

The initial progress was going pretty smoothly: I made use of rust-analyzer's syntax library, lowered items to internal representations, then built definition maps and module structure, got all the declarations indexed. It was so surprisingly straightforward that I decided to do some primitive body lowering. Then I decided to add very very simple type propagation. Then it turned out that naive type propagation doesn't give me much -- but I already had these nice inlay hints, so I wanted more. Overall, I don't care about complex cases and nightly features, right? (_Right?..._). So then came naive trait resolving via impl header matching. It's quite addictive, you get it.

The illusion, however, broke when I decided that it is pretty reasonable to expect the following code to be supported as well:

```rust,name=main.rs,linenos,hl_lines=2
fn mul_by_two(vals: &[u8]) -> Vec<u8> {
    vals.iter().copied().map(|v| v * 2).collect()
}
```

The _code_ is pretty simple, but in order to support it we need:
- Slice type support
- Closures / Fn traits
- Trait solving
- Associated type projection
- _A bunch of nightly stuff_

the last item is funny: I wanted to avoid nightly, but I somehow didn't think that `std` (or sysroot in general) _breathes_ nightly. Welp.

So all in all, one feature after another, I slowly was getting from "smart ctags" to a "real LSP".
Probably, the three biggest milestones were:
1. Declarative macro expansion (I hate declarative macros now). Thankfully, I was able to reuse most of rust-analyzer's infrastructure for that.
2. Proper type inference engine. It was a big "oh wow" moment when I truly realized how type inference works (in short: we "link" all related type bindings in a big inference table, and then we try to get evidence from all possible places, where providing evidence can solve types for multiple places). It was the moment that probably brought me the most joy during the work on this project so far.
3. Proper trait solving engine. I initially wrote "it's highly unlikely that we will have a trait solver in this project", but then I _really_ wanted to get the abovementioned iterator example to work properly. I resisted integrating trait solver for a while, trying to have naive hacks like naive trait impl matching + specialized handlers for `std` traits, but it was getting more and more complex while working pretty poorly. Then I gave up and integrated Chalk, which turned out to be significantly simpler than the whole hierarchy I have built. Making Chalk fast was another challenge, though.

Somewhat separately, probably the thing I am most proud of (and the thing that made Rust Glancer possible -- had I not designed it early, the project would die very quickly) is a cool profiling stack that can measure performance, memory usage (both natively, tracking actual allocated objects, and with jemalloc), profile data on demand, and compare LSP against rust-analyzer, as well as a set of benchmarks running in CI. If you're interested, it's partially covered in the docs ([1](https://rust-glancer.github.io/docs/development/MEMORY.html#memory-tooling--techniques), [2](https://rust-glancer.github.io/docs/development/PROFILING.html)), but I'll work on a more detailed coverage later.

Probably ~1.5 months ago I started using Rust Glancer as my daily driver instead of rust-analyzer. Now, I am happy with its state enough to present it to a larger audience.

## LLM use

This project was built with heavy use of LLMs. It is not vibe coded, though.
I am verifying each pull request to make sure that I am happy with the state of the codebase. If you need proofs, you can check the git history: it has PRs with 10k+ lines of diff, but these are multiple days apart despite the fact that I work on this project nearly every day since its inception. I care about the code, and tbh it would be weird for me to spend 4 months creating a _Rust LSP_ if looking at the code wasn't something I do a lot.

I am not going to pretend that I am an experienced LSP developer and the code is perfect. It is in a state that I can work with, but I understand that some bits might not be idiomatic in terms of compiler tooling design. The code has a lot of comments, and I tried really hard to make sure that these comments are not sloppy but helpful, because _I_ have to read them all the time; so far the quality is obviously not as good as professionally written human docs, but IMHO it's pretty helpful and not annoying to read.

A large part of the journey is learning. LLMs can be pretty good domain experts, and LLMs know about LSP design much more than I do. At the same time, LLMs are not great at building big projects. So the following loop happened multiple times during development:
1. I build something new.
2. LLM proposals seem reasonable, so I go with them.
3. It works but something bugs me.
4. I think about the design for a while and see a big flaw.
5. I work with LLM to fix it (sometimes for a week, if the screw up was particularly big -- but the bigger the screw-up is, the more I learn).

So on one hand, if I am to attribute code ownership to the LLMs, I can complain: "LLMs tried to derail the project so many times!11". But since it's _my_ code, I think that the code might get worse at some moments, but as I learn, I get to improve it. Which is pretty normal software development flow, just accelerated.

All in all, LLMs are just a tool, and it's one's choice to use it responsibly or outsource thinking to it.
Given the amount of witch hunting today, I have just one request: do not reduce me to a clanker. It is my code, so if you consider it to be slop, call it _my_ slop, not AI.

I am open to criticism and will happily listen to feedback: the more I learn, the more I can improve the codebase. Whether I use LLMs for that or not does not matter that much, in my opinion.

## What's next

The project is already in a state where it can be a daily driver for some users, but I have rather big plans for it.
So in the coming releases, you might expect:

- Further performance optimizations
- Some more memory optimizations (primarily during indexing, plus there are a few fragmentation issues happening after a full indexing run that I want to fix)
- Improved type inference / syntax support.
- Code actions (implement missing trait fields, auto-imports, etc).
- Potentially proc macro support (I have some weird idea that will not require actual code execution, but it'll take a while to prepare).

Some features are unlikely to be supported though, such as build scripts / proc macros support via proc macro invocation (e.g. anything that requires untrusted code execution). I also don't plan to work on things that are unnecessary at the current state of the project, such as migrating to the new trait solver. Niche things like particular nightly features will likely be postponed until the project reaches some degree of maturity with stable Rust.

Additionally, there is a lot of cool little tricks I've done in Rust Glancer that I'm somewhat proud of (aligning allocation lifetimes to reduce memory fragmentation, engine-as-a-subprocess model to help with both memory fragmentation and multi-workspace projects, sharded cache, and others), so if people will be interested, I'll be happy to write some blogs telling about how Rust Glancer works under the hood. It's partially covered in the docs already ([1](https://rust-glancer.github.io/docs/architecture/ARCHITECTURE.html), [2](https://rust-glancer.github.io/docs/development/MEMORY.html)) if you want to get some info right now.

But in any case, I hope that the project can be helpful for some folks already, and for more folks in the future.
