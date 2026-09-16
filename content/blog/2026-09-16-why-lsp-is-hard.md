+++
title = "Why building a Rust LSP is hard"
date = 2026-09-16
description = "An under-the-hood walkthrough for a Rust LSP"
+++

A long, long time ago, [mighty matklad](https://github.com/matklad) used to write great posts about how Rust tooling works. Those were great times, but alas, the last [rust-analyzer blog post dates 2023](https://rust-analyzer.github.io/blog)

I am no matklad, but I'm building [Rust Glancer](https://github.com/rust-glancer/rust-glancer), an experimental Rust LSP, for quite a while now. It's probably the most interesting and ambitious project I've worked on, and I want to share some things I've learned while working on it.

![Introduction meme: "hello, r/rust speaking" - "matklad doesn't write about LSPs anymore" - "then write about LSPs yourself" - "me???"](/assets/2026-09-16-lsps_are_hard/r_rust_speaking.png)

This will be a (hopefully coherent) story about how Rust LSPs work, from the perspective of both rust-analyzer and Rust Glancer: how things that seem easy turn out to be hard, things that seem hard turn out to be even harder, and things I didn't expect to exist at all somehow do.

Obviously, a single blog post can't cover everything, this will be a very technical but still architectural overview rather than a deep dive into any particular topic brought up along the way. Those will come as separate posts, granted I won't be lazy.

Otherwise, be ready for many anecdotal chapters that have one thing in common: building an LSP means having to produce useful answers from partial information.

> [!NOTE]
> **Disclaimer**: I am no expert in building LSPs, and the purpose of this post is to make readers interested in internals and caveats of LSPs rather than give an unambiguous and formal design overview. I intentionally try not to use compiler jargon, and use approximate phrasing in many places to focus on the overall meaning rather than precision. There are plenty of links in the post to more detailed/precise sources, and I recommend checking them out!
>
> Also, I have read a lot of rust-analyzer code before and during preparation of this post, but I'm no rust-analyzer maintainer; if I got some things wrong -- sorry.

## Where does an LSP start?

LSP server has two opposite ends: the server that implements the [Language Server Protocol][lsp] (as in, "there is this thing I can send requests to and receive well-formed responses") and the actual state that we want to serve (as in, "the sent queries actually do what they need to do and operate over some kind of indexed state"). The first seems to be a solved problem, right? Especially given that [tower-lsp-server](https://github.com/tower-lsp-community/tower-lsp-server) exists. Welp, not really. Let's start there, and then we will gradually get to indexing once we actually need it.

The LSP begins with a client sending an [`initialize`][lsp-initialize] request which requires you to initialize the LSP (huh). Before you respond, client won't do anything. Once you do, it sends an [`initialized`][lsp-initialized] notification, and all is good, and LSP communication starts.

The problem is: when do you respond to this request? Once the server starts, you have nothing. You don't know anything about the project, and only when you receive this request you will know what's the codebase we're talking about. And in order to actually answer any queries, we need to "index™" it. We don't know what indexing means yet, but it's certainly a lot of work.

Do we block until we've indexed everything? Then users will enjoy 10-20-50-100 seconds of waiting with editor being nearly useless. Not an option. Do we start right away? But then what do we answer to the imminent first query about the currently open file? Won't that cause us to block there instead? How to avoid the scary "we need to index everything" problem?

And this reveals the first huge difference between the compiler and LSP. Compiler has a rather binary definition of done: the binary (sorry) is either compiled or not. Technically, compiled shared libraries and other build artifacts are usable as well, but in practice you will be annoyed if compiler compiles 715 out of 716 crates in your workspace and then stops. LSP is different: we can provide useful results _almost immediately_. We don't need complete information at the first millisecond, we need to send something useful to users as soon as possible. We only need to decide what we count as "something useful".

The answer to the original question is: we need to do the least amount of useful work that will make processing queries possible. Thus both rust-analyzer and Rust Glancer just validate the provided config and respond. rust-analyzer schedules workspace discovery to start _after_ the response, while Rust Glancer will remain passive until the first query hits.

Once the handshake is finished, the real deal starts: you get your first actual queries. In most cases, these likely will be [`textDocument/didOpen`][lsp-did-open], [`textDocument/inlayHint`][lsp-inlay-hint], and [`textDocument/documentSymbol`][lsp-document-symbol]. If the user is eager and you're unlucky, there might even be [`textDocument/didChange`][lsp-did-change] in between these. And the complexity explodes.

First, fun fact: LSP as a protocol doesn't want you to think about the filesystem. There is no filesystem, there are just documents and edits. Which makes sense: often times, the document is not saved, so you can't know its contents. Except it doesn't. In most languages, analysis of a single file (or a set of open files) in isolation stops being useful fairly quickly. 

Enter hell: LSP assumes that it's the source of truth, but you still need to access the filesystem yourself, and do it in a synchronized way. To make it more fun, edits can happen outside of the editor, and the client might not be very faithful in notifying you about such events. And that's why we need a virtual file system, and "source generations", e.g. identifiers of the state of source code at the time of currently executed request. If we will try to naively combine filesystem access and LSP notifications, it will turn the whole project into a never-ending race condition. Instead we load the project sources to memory, declare it a VFS, and try our best to apply any changes on top of this loaded state, and each time we change the state, we update the source generation, which lets us have consistent internal state (and cancel in-flight queries as they get invalidated).

"What in-flight queries?", I hear you ask. And that's the second fun fact. Executing an LSP query might entail a suprising amount of work, and not all queries made equal. Looking for references for a symbol is a fairly non-trivial task, while `hover` is typically cheap. Therefore doing one query at a time is not an option, you need to execute read queries in parallel. And whenever something changes state, the currently running queries will be doing now useless work against now outdated state. Your job is to create a loop which separates mutating and non-mutating queries, lets read requests run in parallel, and cancel work once state changes. And also, if you're unlucky to use async, serialize incoming messages to make sure that your `didOpen` and `didChange` don't come in the reverse order which could be a hell of an issue to debug (I wonder why I needed to make this remark).

Third and final fun fact is that LSP authors actually considered that you might not be ready, so they gave you useful instruments to deal with that, such as [`workspace/inlayHint/refresh`][lsp-inlay-hint-refresh] server request. With such a powerful tool, you can say "oops, try again now pls" and send the _actual_ response even if initially you sent nothing. The problem is that not everything can be refreshed. Document symbols can't; if you don't send them right away, they will be stale until client itself decides that it's time to ask again. Which means that for some queries you might need to get creative.

But we've got distracted. Client waits for inlay hints and document symbols.

And we still haven't indexed a single thing.

What do we do?

[lsp]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
[lsp-initialize]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#initialize
[lsp-initialized]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#initialized
[lsp-did-open]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_didOpen
[lsp-inlay-hint]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_inlayHint
[lsp-document-symbol]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_documentSymbol
[lsp-did-change]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_didChange
[lsp-inlay-hint-refresh]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#workspace_inlayHint_refresh

## Server, at your service

Lucky us: to answer document symbols, we truly have to index a single thing. The currently open file.
And this is actually a perfect example of LSP being useful very fast. All you need to do to answer this request is parse the file. An AST (or rather CST, but we'll get to that) will already tell you which structures, traits, functions, methods, etc you have. You can even do that as a part of the request on demand.

[`textDocument/hover`][lsp-hover] over a `Bar` in `fn foo(a: Bar) {}` is a bit trickier: it requires _semantic analysis_, at least in some form. You need to know where does the thing under the cursor comes from. For that to exist, you need to understand which items (structs, methods, you get it) are available in the scope. To do that, you need definition maps: resolved "what can be seen from where" maps for each crate and module. And to get definition maps, you need an extra layer of lowering. You could still work on AST/CST level, but it won't be convenient. Likely you want to have an _item tree_, your own representation of items defined in each file. So you need to parse each file -> build an item tree from AST/CST -> resolve modules and build a definition map -> check what's visible under the cursor -> find it through defmaps -> extract documentation for the resolved item -> show it. If you are wondering what does "under the cursor" mean, treat yourself with something savoury for a great question, we'll get to back later. For now, it's _quite a bit_ of extra work, but still fairly manageable.

Inlay hints are significantly trickier (as well as hovering _inside of a body_, e.g. on a local variable). They appear inside of _bodies_. In `fn foo() { let a = bar(); }` we can say that `fn foo` is an _item declaration_, while `{ let a = bar(); }` is a ~~real scary part~~ body. Note that in the semantic model described above we didn't care about bodies at all. Not only that, but for good inlay hints we need no less than _type inference_. And for now I will refuse to elaborate.

But if you think that it ends here, behold the final boss of the LSP: [textDocument/references][lsp-references]. For inlay hints, you need to analyze bodies in _one file_. For references, you hit an innocent `option+shift+F12` on a function definition in VS Code (or any other editor that for some reason has the same keybinding), and the poor server must find _all uses of that function in all discoverable places across the workspace graph_. Think `Option`. We're talking _quickly_ going through thousands of bodies where we need to distinguish _this exact_ `Option` from any other item named `Option`. And this creates a bigger problem: even if you have all the bodies analyzed handy, you probably don't want to go through all of them linearly to see if any happen to mention `Option`. That's where LSP-specific shenanigans come to play: you might build a reference search plan using text matching, find only a subset of files that _might_ contain this identifier, and go through bodies only there. Which still could be a lot of work. If you wonder what a "reference search plan" is, [rust-analyzer has a great post on it](https://rust-analyzer.github.io/blog/2019/11/13/find-usages.html) (all hail the mighty matlkad!).

_Sidenote: if you're thinking "Well, yeah, Option has a lot of textual matches, but it's a pathological case"... Building LSP is **ALL** about pathological cases that ruin the experience for users, which is also one of the reasons why LSPs are hard._

Two important things here:
1. Indexing itself has layers to it that form a sequence with pretty much established boundaries.
2. Different queries require different amount of precision / knowledge about the codebase.

And one of the freedoms available to the LSP is how to utilize this information.
Both rust-analyzer and Rust Glancer technically have parsing / item tree / defmaps / semantic layer / body layer (and I'm using Rust Glancer terminology here, but I think people familiar with rust-analyzer immediately understand what is what), but they differ in how this data is calculated.

rust-analyzer uses [salsa](https://github.com/salsa-rs/salsa): an incremental database. It means that you can define inputs and logic on how to transfer inputs to outputs, and then outputs are lazily computed and memoized. If some inputs change, only the relevant parts of outputs are invalidated and recalculated. rust-analyzer model is _elegant_: there is no indexing at all. There is this net of relationships between inputs and the state of codebase, so at any point in time you can ask for the _state_ and salsa will make sure that it's comupted for you. It doesn't have to "index" anything else rather than what's directly asked. To be honest, salsa feels like magic, and if you're not familiar with it I highly recommend dedicating a couple of evenings to get familiar with it, you won't be the same (see also [Durable Incrementality](https://rust-analyzer.github.io/blog/2023/07/24/durable-incrementality.html) and [salsa docs](https://salsa-rs.netlify.app/)). But even with salsa, shenanigans are needed. If every query will only compute what's necessary, even with memoization, there will be _a lot_ of the state that is not computed, and editor might feel laggy initially. Which is why rust-analyzer by default enables _cache priming_ (there is no blog post about it, but [this PR](https://github.com/rust-lang/rust-analyzer/pull/4133) is the state of art!) that will basically do the indexing for the workspace up to the semantic layer globally, since this is the information you likely need handy all the time. Bodies can wait until they're truly needed.

Rust Glancer is different. Its focus is low RAM and instant editor restarts, which go together. Rust Glancer wants to eagerly do as much work as possible and tries to index _everything_ once and then offload the state to the filesystem so that you don't need to compute much after initial indexing. But here shenanigans are needed as well! Full indexing takes a lot of time, so, first of all, Rust Glancer starts answers queries as soon as the relevant part of semantic analysis is done (remember cache priming? similar logic here), and for bodies it will prioritize the currently open file. Compared to rust-analyzer, initial indexing will take more time and (currently) might consume more RAM since it's eager and does more work, but after that you're basically done. If something changes, you only update relevant bits. If editor restarts, state still exists in the filesystem, which makes indexing almost instant. You only need full reindexing in rare cases (e.g. when workspace graph changes).

Coming back to queries: our LSP now actually has the state it wants to serve, and it can either be ready or not ready. Whenever engine is not ready, it might provide an imprecise answer that will be as useful as possible, and in many cases it will be able to ask the client to refresh results once the state is computed.

And that's how LSP works! Thanks for reading! Except...

[lsp-hover]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_hover
[lsp-references]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_references

## One workspace, two workspace

I bet you [noticed](https://www.britannica.com/art/foreshadowing) the "(workspaces?)" in the first chapter and are surely wondering since why I am writing as if the opened folder is guaranteed to be a single rust workspace. Because it certainly isn't. The opened folder might contain 5 folders out of which 3 are rust workspaces and 2 are not. The opened folder can be a crate inside of a workspace. The opened folder might have a rust file without being a rust crate at all. The previous chapter actually jumped a bit too far and we need to get back to the drawing board.

Let's start with a simple question: how does an LSP get activated, and once it does, how does it decide what the  project even is? It comes from the client, obviously. If you're controlling the client, you can describe that yourself. For example, you might say that the current folder must have a `Cargo.toml` file. Or you might say that any of the immediate children folder might contain `Cargo.toml` file -- this is what rust-analyzer does. Then if you open a folder with N workspaces, they all will be discovered and will start indexing. You potentially might go even further: do a recursive scan to see if there are workspaces inside of workspace folders (if, for example, they're under `exclude` in the parent workspace `Cargo.toml`). This is an extreme version and rust-analyzer does not do that.

There is an opposite problem too: what if the folder does have rust files but no `Cargo.toml`. Client might still try activating your LSP once you open an `*.rs` file, so what do you do? One strategy would be to use `cargo locate-project` to find the root, if it exists, and still index the codebase even though the root lies outside the directory. But does user _want_ this? Maybe they opened a particular folder _specifically_ because they don't want a full blown analysis?

Similarly, when you open a folder that contains multiple projects, does user _want_ all of them to be discovered and analyzed? Sometimes yes: it could be annoying to open a new project and see that it's not indexed even though you opened an IDE an hour ago. Sometimes no: it could be annoying to open a folder with 8 heavyweight projects and see hear your CPU fans go brr because LSP started indexing everything in parallel.

Unlike with compilation / running `cargo check`, which is an explicit user request, the user intent with LSP is not clear. They just opened a folder, they did not necessarily signal that they want one behavior or another. So, there are no right answer, there are the project authors decisions.

rust-analyzer tries to be eager in workspace discovery, and, with cache priming enabled, it can be quite noticeable. Similarly, it tries to be helpful and will go outside of the project directory if that's required to provide good experience for the user.

Rust Glancer takes an almost opposite stance here: it _requires_ `Cargo.toml` to be in scope for analysis to run, and it will not start indexing workspace until you actually open it. This makes it more lazy and strict, in a way: it does not try to guess for a user, and tries not to go outside of the scope provided by the user. And still, a counter-argument can be made here: it will still check the cargo registry. It's not like the policy can be completely pure.

But the problem doesn't end here. Imagine that the folder has two rust workspaces. What if one is well formed and one is not? The weird part is that LSP itself does not give you much tools to distinguish these. In rust-analyzer, if even one of workspaces can't be processed for whatever reason, the whole server will enter the error state and will be marked red in the VS Code status panel. Even though other crates will work! But then, rust-analyzer still uses a single process to manage all the workspaces (and it's another nice property of salsa, it makes such model pretty natural), so if a single crate manages to crash rust-analyzer, it crashes globally.

Rust Glancer again takes a different approach: the LSP server itself is just a router, and each workspace is modeled as a separate process (engine). LSP server can spawn engines on demand, it has its own communication protocol for them, and crash in any of the editors does not mean global crash. Bonus property here is that it helps with low memory usage: data from different engines does not mix with each other, reducing the fragmentation (because a lot of allocations with different lifetimes _is_ how you get memory fragmentation). It, however, has its own drawbacks: it's significantly more convoluted and generally fights against LSP design. It also requires quite some shenanigans in the state reporting.

The useful lesson here is even given that LSP itself is a well defined protocol, it gives implementation plenty of space to decide how exactly they want to work and how they interpret user intent. Neither of approaches is inherently right or wrong. It's up to you to decide what you want to prioritize. [And users _do_ have different opinions on what is right](https://github.com/rust-lang/rust-analyzer/issues/17537).

## You want no LSP

How many fun facts we have learned about LSP so far? Well, here's the next one.

LSP defines a _protocol_, and protocols are known to be often ~~weird~~ optimized for communication within a specified domain. And the domain is, obviously, editor. It speaks not in terms of byte offsets or character indices, but in terms of lines and columns. Moreover, the protocol demands that your server knows how to speak UTF-16. Who doesn't love UTF-16?

The problem with that is that, first, working with lines, columns, and UTF-16 is not really convenient. You probably want some kind of the protocol bridge allowing the server itself work with offsets and UTF-8, and only convert these values near the actual protocol communication boundary. But that's pretty normal, and is arguably a best practice, regardless of the protocol at hand. Domain model of your application doesn't have to be equal to the domain model of the protocol, it's sufficient for it them to be isomorphic.

_However_ the question arises: if you work with offsets normally, how do you convert these to lines and columns? Having to parse the full text of the file, split it into lines, and shift offsets would be, ugh, _slightly inefficient_. While the protocol domain is not _necessary_ inside of your representation, you still need tools to make conversion efficient. For example, by creating line indexes for each file. Both rust-analyzer and Rust Glancer do it.

The funny bit here is that even though you want to abstract LSP away, you can't really do it in full; it will still leak into your architecture.

And the "attached metadata" doesn't stop there. Besides analysis and read queries, LSPs are also used for editing. They typically can handle imports for you, have some snippets, and support code actions like replacing qualified path with an import or implementing missing trait members. And what do such edits often contain? Newlines! But which ones? We can't just assume that on windows it's always `\r\n` and on unix it's always `\n`. If we don't guess, we will do an inconsistent edit. It means that besides line index, we need to detect and store the kind of line endings used in this particular file. BTW, another refactoring tool, rustfmt, also has to think about it, but since it rewrites whole files rather than do granular edits, you can configure its behavior to be either auto (detect), unix, windows, or native (OS default).

And metadata doesn't stop there either. To properly parse the file, you also must know its edition. Otherwise, you won't know if `gen` is an identifier or a keyword. Which means that we can't really analyze a file in isolation: we need `Cargo.toml` (or other kind of project metadata) to even know how to properly parse it.

As you can see, the demand for metadata comes from all the possible directions: LSP, file contents, rust itself. In a way it is funny that such a simple operation as parsing also has to be stateful.

## Indexing wen

OK, OK, it's a long article and we still only briefly touched indexing, which is supposed to be the hardest part.

The thing is, indexing is _indeed_ the hardest part, and to be honest it deserves a series of similarly-sized articles on its own. But just so that we don't have gaps in our LSP journey, let's have a high level overview.

First, an important bit: an LSP can have fundamentally different designs and might approach indexing differently. Once again, there is a [good post](https://rust-analyzer.github.io/blog/2020/07/20/three-architectures-for-responsive-ide.html) on this in rust-analyzer blog. In short:

- First: have "full analysis" and "shallow analysis" phases, where full analysis checks a lot of stuff, and shallow analysis is fast and works per file. That's the approach Rust Glancer takes, among others.
- Second: utilize compiler to do work for you and snapshot its state. While it'd be a stretch somewhat, we could say that RLS - the first Rust LSP - [worked this way](https://github.com/rust-lang/rls/blob/master/architecture.md). This approach works for some languages, especially headers-based, but for Rust it proven to be very inefficient.
- Third: make it incremental/query-based. Have the LSP compute just enough data to answer a query, without thinking much about anything else. That's how rust-analyzer works with the power of salsa.

The approaches define _how_ indexing is executed. However, the phases of indexing will likely be more or less the same. For rust it's:

- Parsing (I consider lexing to be a part of parsing): take input text and translate it to the CST representation.
- Item tree building: extract the information that serves as input for the later state of indexing. CST is useful but way too low level. You want to know what _items_ you have, e.g. "this is a struct with these fields, this docstring, these attributes, and fields, and it has this visibility" as opposed as "struct node with N tagged children".
- Definition map building: which modules do exist, and what do they contain? What is exported from this module? What is reachable from this module (including: "this is imported as alias, so we must resolve this original import and make it visible inside of module as an alias")? 
- Macro resolution: macros are interesting. They expand to more code that also must be analyzed. Moreover, they can bring more items and even modules do the scope. After expanding itself (which has a bunch of quirks of its own), we need to make sure that expansion changes the state of defmap, which makes it convenient to make macro resolution a subphase of defmap building process itself.
- Item index building: after item tree building we might have representation for each structure and each impl block, but how are they linked? Is `impl Foo` related to `crate::a::Foo` or `crate::b::Foo`? We need a phase to create "linked item state" -- what unique items we have, which impls correspond to what, which trait impls correspond to which trait and trait implementor. Building an index here is especially important: being able to enumerate items for a structure is essential, so while we _could_ in theory work with an unlinked item tree, it would've been neither efficient or pleasant.
- Body resolution. All of the above doesn't care about bodies at all, and contains a fair bit of useful information, but it is the bodies that are the actually useful part of any program. And for bodies we need to parse all the statements/expressions/patterns, allocate all the bindings (e.g. assigned variables), declare scopes (what bindings are visible where), link all of the above, and then perform type inference and trait solving. The latter two _are_ the scary part.

At the end of indexing, regardless whether we analyzed the full workspace or just did enough work for a single query, we end up with _indexed state_: our representation of things that are declared in the project, so we can answer which type this variable has, which methods are available for it, which documentation should be shown for this structure, etc.

The important part here is that indexing doesn't just have to go through everything, the end shape is declared by the queries we want to process, not by all the theoretical information we could infer from the codebase.

Unfortunately, the indexing is not as linear as it's presented above. Take defmaps for example: if you have `use bar::baz; use foo::bar;`, on the first pass you will learn that `bar` is in the scope, but won't have this information to resolve `bar` immediately. Similarly, with `use bar::generate_gen_mod; use gen_mod::Foo; generate_gen_mod!();` you first need to add `generate_gen_mod` to the scope, then expand it to add `gen_mod`, analyze `gen_mod`, and only then you will be able to resolve `use gen_mod::Foo`. So indexing uses quite a bunch of "fixed loops": we keep repeating analysis while we get more information, and stop working as soon as there is no more new information (or loop limit is exhausted).

Similarly, body analysis is somewhat recursive: bodies _themselves_ can contain items, macros, impls, which can have bodies tha contain items, macros, impls, which can... You get it. Each body also gets its own defmap with its own fixed loop, index of body-local items, and analysis of bodies inside of this body.

And yeah. Type inference. Trait solving. Sorry, but this will remain a mystery until the next blog post. We're talking about LSP itself here, and for this purpose it's enough to know that these two contribute additional information to indexed state.

Interlude ended, back to LSP quirks.

## When being a compiler is not enough

The compiler itself does the above "indexing" and more. However, it has a luxury of being strict: if the code is not correct, it gets to yell at you and fail the compilation.

LSP can't do that. The code in IDE if very often incorrect because you're just typing it (well, if you're doing it _old fashioned way_), and LSP is meant to help you finish it. LSP cannot say "I will not analyze this code, it's incorrect or not complete".

Thus, the adventure starts from parsing: parsing _must_ succeed no matter what user typed, and we must try interpreting the state given the information we have at hand. We also must assume that user breaks the rules: there might be two methods with the same name inside of impl block, there might be an `impl` for a trait that does not exist in the scope, or the code just might be incomplete. 

The parsing bit and the need for CST already have write-ups by you-guess-who (yes, again!): [1](https://matklad.github.io/2018/06/06/modern-parser-generator.html#API), [2](https://rust-analyzer.github.io/blog/2020/10/24/introducing-ungrammar.html), [3](https://matklad.github.io/2023/05/21/resilient-ll-parsing-tutorial.html).

But parsing is only part of the problem. Once we have successfully parsed a file, we need to actually process the incorrectness/ambiguity, and turn it into something useful.

Consider a perfectly normal `fn fo` at the end of the file. What we need to do is to realize that since the previous token was `fn` likely the intention is to declare a function, and we already might suggest a snippet to generate the function declaration with placeholders for parameters and an empty body. If some item does not exist in the scope, we might still find possible candidates and suggest adding an import. You get the idea.

So it is another norm of LSP: you have to consider that the state is _incorrect at the moment_ and _can be improved_. How far you will go depends just on your imagination. Once again you're trying to guess the user's intent rather than work in a strict world of correct code.

But it doesn't stop there! You don't only need to work with incorrect code. Users use more than just the compiler: they use cargo, they use rustdoc, they write documentation in markdown. As a tooling author, you need to know how to work with cargo JSON output to extract diagnostics, remember that rustdoc supports [disambugulators](https://doc.rust-lang.org/rustdoc/write-documentation/linking-to-items-by-name.html#namespaces-and-disambiguators), be able to extract and run the tests for user, and so on.

It's less of depth expansion, and more of width expansion: you need to think about the tooling user uses, and do all the necessary to make the flow feel "fluent" and your LSP "just do the thing".

## Cursor: the god of LSP

Now we have an LSP server, indexed state, a bunch of extra knowledge about tooling. It's time to finally touch the central part of the lsp: the _cursor_.

Anything you do in the editor is based on the _cursor_: the position inside of the file that requires action from LSP. It could be a mouse cursor (e.g. for hover), or the typing position (e.g. for completions).

The interesting bit is how do you go from "I need hover information/completions at this position" to "what exactly is located at this position"?

As usual, matklad has [a great post](https://rust-analyzer.github.io/blog/2023/12/26/the-heart-of-a-language-server.html) about how the symbol under cursor is found in rust-analyzer. In short, rust-analyzer looks for sources based on the _syntax node_ matching to the semantic element, which works great with lazy analysis approach and reliance on parser infrastructure for refactoring (or at least it is my understanding).

Funnily enough, Rust Glancer takes an almost opposite position here. The article states that span-based approach is a) too slow, since LSP tries to do the least amount of analysis possible, and b) it's less convenient for refactoring. The implied c) is that analysis might not be computed, but parsed tree for the current file is always available. In Rust Glancer, the opposite is true: it defaults to full analysis that is offloaded to the filesystem, and it eagerly evicts syntax trees to free up memory. Having a full semantic analysis at hand, span-based approach works pretty well combined with hierarchical structure: you can (for example) first filter out mismatching files, then bodies that do not touch the cursor position, then iterate through body contents looking for a source symbol with the most precise span. It does not give the refactoring benefit, so Rust Glancer implements refactorings as set of dedicated algorithms that do not rely on anything like `rowan`, which is significantly less elegant, but seems to be working rather well. Additionally, somehow the _refactoring_ part, while being very important, takes not that much of the implementation logic. I'm still not sure if it should be put to the basis of the overall architecture (for the Rust Glancer purposes; every project obviously can decide for itself).

But that's only half of the problem. Sometimes understanding _where we are_ is not sufficient, and the most important example here is completions. Once we understand _where we are_, we need to come up with a list of suggestions that make sense in this particular context. And as it usually happens in positions where completions are needed, the code will likely be incomplete, making the guesses a bit harder.

For completion purposes, we are interested less in what is exactly under the cursor, and more about what is _around_ the cursor. For example:

- Is the cursor right after the dot? Then we need dot completions: understand the type of the symbol before the dot and find matching methods.
- Is the cursor right after `::`? Then it could be an associated item, use path, or qualified path, so we need to check what comes _before_ `::` and sometimes suggest different options.
- Are we inside of the struct initializer, like `User { na$ }`? Fetch fields from this structure. Or if it's `User { name: fo$ }`, then fetch matching locals.
- Is it just `f` in an empty file? Then `fn` keyword (or `fn` snippet) may be applicable.

In practice, this becomes a ton of special cases that you want to support. And you can get as creative as you want here: for example, you might take the edition of the crate into consideration to decide whether you want to suggest `await` keyword or not.

Once again, it becomes a game of guessing the user intent, and the better you do it, the better experience the user will have.

## That's NOT it

This is a long article, isn't it? And I could go on for much longer.

I hope that it does not look as a set of inconsistent anecdotes, becuase the intent was to show that there are way too many angles from which you could look at LSP, and each angle can have multiple approaches to do the thing.

It creates a pretty big contrast with the compiler or tools like `cargo fmt` / `cargo deny`: they are fairly deterministic in their _goal_, and the indedned behavior is more or less clear and configurable. When user invokes these tools, they know exactly what they need, and the invocation is the _act of showing the intent_.

LSP is more of a guess game, where at each step all you are presented with is the potentially incorrect state, and your goal is to guess what would make sense for the user.

Which is hard. But also fun!

P.S. Rust Glancer itself is already [pretty capable](https://rust-glancer.github.io/blog/0-2-0/), you might check it out! If you want to support the project, you might consider [giving it a star](https://github.com/rust-glancer/rust-glancer) (but only if you indeed like it / find it interesting!) and/or follow me [on twitter](https://x.com/popzxc_is_me) (I'll be posting Rust Glancer announcements and new posts there; I also plan to occasionally post interesting stuff about Rust). Monetary support is not required for me, but is required for Rust language itself, so I strongly suggest [sponsoring Rust Foundation](https://github.com/sponsors/rustfoundation) instead.
