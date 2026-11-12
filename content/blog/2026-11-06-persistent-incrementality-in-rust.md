+++
title = "Persistent incrementality in Rust"
date = 2026-11-06

[extra]
code_tabs = true
+++

There is this cool idea: incremental computations. The concept is simple, if you calculated something and then inputs change, it doesn't have to mean that you need to recompute _everything_. Most of your computations might still be valid, and quite often it is the case that you only need to redo a small chunk of changes.

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/incremental-computations-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/incremental-computations-light.svg" alt="First, compute all the work. After one input changes, recompute a few pieces. After another input changes, recompute a different few and keep the rest." width="1280" height="470" loading="lazy" decoding="async">
  </picture>
</p>

This concept usually works the best when you need to compute _a lot_ of stuff, and there are _a lot_ of inputs, and these inputs change independently with different degree of likelihood. Probably, the most common example is incremental compilation, which makes the compilation reuse as much work as possible, making iterations during development much faster. The interesting part is "iterating": note that incremental compilation doesn't necessarily makes _cold builds_ faster. The compiler performance might be roughly the same with and without incrementality, it's just repeated reuse of compiler artifacts becomes more efficient. Most likely you've heard of it. And if you did, you probably know that incremental compilation is not _easy_ ([1](https://blog.rust-lang.org/2021/05/10/Rust-1.52.1/), [2](https://blog.rust-lang.org/2022/02/24/Rust-1.59.0/#incremental-compilation-off-by-default), [3](https://goals.rust-lang.org/2026/incremental-system-rethought.html)). But it's cool!

And if incremental computations concept applies well to compilers, it applies even better to LSP servers, because user makes edits in the editor much more often than they recompile code, and each keystroke must change the editor state in milliseconds (unless you go full vibe and don't need an IDE anymore, that is).

It could be _somewhat related_ to the fact that [rust-analyzer](https://github.com/rust-lang/rust-analyzer) uses [salsa](https://github.com/salsa-rs/salsa) as the central part of its architecture. Salsa is a library that makes incremental computations very convenient and efficient. There is one drawback, though. It is mainly designed to work in memory. And we'll touch on how it works in a bit.

For project like [Rust Glancer](https://github.com/rust-glancer/rust-glancer) that tries to keep the memory usage as low as possible, this doesn't work. Because of that, for a long time Rust Glancer didn't use incremental computations, and instead had a sophisticated network of persistent caches with sharding and targeted optimizations to make computations efficient. And it worked, for a while. But this approach doesn't scale very well: if you need to maintain a manually implemented custom cache format, optimize it, and tie computations to it, then the more efficiency you seek, the more complexity you get. Basically, the complexity is "quadratic": it grows as `O(computations_complexity * cache_implementation_complexity)` because both are interconnected (sorry, CS purists, for this crime).

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/cache-coupling-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/cache-coupling-light.svg" alt="Business logic and caching intertwined with many cross-connections, compared with the same components encapsulated behind separate boundaries and a single API." width="1280" height="520" loading="lazy" decoding="async">
  </picture>
</p>

So... Rust Glancer got to a point where it would _really_ benefit from persistent incremental computations. And the search for it turned out to be really interesting, so in this blog post we'll be discussing how incremental computations can work in memory and how to make this approach work with persistency.

## Salsa

Before we start discussing how incremental computations work under the hood, let's see how it _looks like_.

If you know how to _use_ Salsa feel free to jump to the [next section](#inside-salsa). If you're familiar with red-green algorithm and in-memory approach that Salsa uses, you can skip [to where persistency starts](#enter-persistency).

Now, incremental computations are somewhat tricky to explain in a blog post, because the value of it requires an application to be somewhat big. So we will need an example that is big enough to show the value of incrementality, but small enough to discuss here. It's a bit absurd, but I hope you can focus on the idea, not on the value of the snippet at hand.

Let's imagine that we're doing a weird text processor that would count the words in all the files in the directory, and decide whether this count is funny. And to make things more interesting, the files can include other files.

How would that look if implemented naively? Something like that, most likely (well, let's ignore the IO):

{% <code_tabs id="naive-example" label="Naive implementation" tabs={["queries.rs", "main.rs"]} combined_label="combined"> %}
```rust
type FileId = usize;

struct File {
    name: &'static str,
    text: String,
    includes: Vec<FileId>,
}

struct Db {
    files: Vec<File>,
}

fn word_count(db: &Db, id: FileId) -> usize {
    let file = &db.files[id];
    println!("word_count({})", file.name);

    let own = file.text.split_whitespace().count();
    let included: usize = file.includes.iter()
        .map(|&child| word_count(db, child))
        .sum();

    own + included
}

fn is_haha_number(db: &Db, id: FileId) -> bool {
    println!("is_haha_number({})", db.files[id].name);
    matches!(word_count(db, id), 67 | 69 | 420)
}

```
<!-- tab -->
```rust
fn main() {
    let mut db = Db {
        files: vec![
            File {
                name: "a",
                text: "hello world".into(),
                includes: vec![1],
            },
            File {
                name: "b",
                text: "one two three".into(),
                includes: vec![],
            },
            File {
                name: "c",
                text: "not connected".into(),
                includes: vec![],
            },
        ],
    };

    let (a, b, c) = (0, 1, 2);

    println!("Result: {}\n", is_haha_number(&db, a));

    // Change b's text, but preserve its word count.
    db.files[b].text = "red blue green".into();
    println!("Result: {}\n", is_haha_number(&db, a));

    // Change b's word count: a now has 67 words.
    db.files[b].text = "word ".repeat(65);
    println!("Result: {}\n", is_haha_number(&db, a));

    // a now has 69 words, but is_haha_number is still true.
    db.files[b].text = "word ".repeat(67);
    println!("Result: {}\n", is_haha_number(&db, a));

    // Replace a's dependency on b with a dependency on c.
    db.files[a].includes = vec![c];
    println!("Result: {}\n", is_haha_number(&db, a));
}
```
{% </code_tabs> %}

the output will also have no surprises:

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/naive-output-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/naive-output-light.svg" alt="Five successive input states. The naive implementation runs is_haha_number(a), word_count(a), and word_count(b) every time until the final edit switches the include from b to c. Results: false, false, true, true, false." width="1400" height="880" loading="lazy" decoding="async">
  </picture>
</p>

Now, let's try Salsa. It should let us make some computations reusable. Here's how it would look like:

{% <code_tabs id="salsa-example" label="Salsa implementation" tabs={["queries.rs", "main.rs"]} combined_label="combined"> %}
```rust

use salsa::Setter as _;

#[salsa::input]
struct File {
    name: &'static str,
    #[returns(deref)]
    text: String,
    #[returns(deref)]
    includes: Vec<File>,
}

#[salsa::tracked(returns(copy))]
fn word_count(db: &dyn salsa::Database, file: File) -> usize {
    println!("word_count({})", file.name(db));

    let own = file.text(db).split_whitespace().count();
    let included: usize = file.includes(db).iter()
        .map(|&child| word_count(db, child))
        .sum();

    own + included
}

#[salsa::tracked(returns(copy))]
fn is_haha_number(db: &dyn salsa::Database, file: File) -> bool {
    println!("is_haha_number({})", file.name(db));
    matches!(word_count(db, file), 67 | 69 | 420)
}

```
<!-- tab -->
```rust
fn main() {
    let mut db = salsa::DatabaseImpl::default();

    let b = File::new(&db, "b", "one two three".into(), vec![]);
    let c = File::new(&db, "c", "not connected".into(), vec![]);
    let a = File::new(&db, "a", "hello world".into(), vec![b]);

    println!("Result: {}\n", is_haha_number(&db, a));

    // Change b's text, but preserve its word count.
    b.set_text(&mut db).to("red blue green".into());
    println!("Result: {}\n", is_haha_number(&db, a));

    // Change b's word count: a now has 67 words.
    b.set_text(&mut db).to("word ".repeat(65));
    println!("Result: {}\n", is_haha_number(&db, a));

    // a now has 69 words, but is_haha_number is still true.
    b.set_text(&mut db).to("word ".repeat(67));
    println!("Result: {}\n", is_haha_number(&db, a));

    // Replace a's dependency on b with a dependency on c.
    a.set_includes(&mut db).to(vec![c]);
    println!("Result: {}\n", is_haha_number(&db, a));
}
```
{% </code_tabs> %}

The code looks pretty similar! However, let's inspect the output.

The first call matches the naive example:

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-output-initial-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-output-initial-light.svg" alt="initial inputs; a: 2 words, includes b; b: 3 words · c: 2 words. Queries that ran, in printed order: is_haha_number(a), word_count(a), word_count(b). Result: false." width="1400" height="220" loading="lazy" decoding="async">
  </picture>
</p>

But the second call is different!

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-output-same-count-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-output-same-count-light.svg" alt="b.text changed; &quot;red blue green&quot;; 3 → 3 words. Queries that ran, in printed order: word_count(b). Result: false." width="1400" height="220" loading="lazy" decoding="async">
  </picture>
</p>

Note: not only we did not call `word_count(a)`, we did not call `is_haha_number` as well!

Salsa can see that file `b` changed, and it re-run `word_count` for it. But the output did not change,
so all the previous computations are valid: nothing to be run.

The third output is interesting too:

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-output-more-words-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-output-more-words-light.svg" alt="b.text changed; 3 → 65 words. Queries that ran, in printed order: word_count(b), word_count(a), is_haha_number(a). Result: true." width="1400" height="220" loading="lazy" decoding="async">
  </picture>
</p>

The word count in `b` changed, and `a` includes `b`, so we need to re-run all three queries. But the order is inversed! This is because we have a dependency graph internally, and we're walking through the dependency tree and re-execute changed queries from the "leaves" to the "root".

The fourth output is the same:

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-output-same-answer-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-output-same-answer-light.svg" alt="b.text changed; 65 → 67 words. Queries that ran, in printed order: word_count(b), word_count(a), is_haha_number(a). Result: true." width="1400" height="220" loading="lazy" decoding="async">
  </picture>
</p>

We have changed `b` from 65 to 67 words, so `a` now has 69 words. Result is still `true`, but we did have to update the computations. If we would've had another query that depended on `is_haha_number`, that's where validation would've stopped and all the queries above wouldn't need to run.

And the final output is interesting too:

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-output-new-dependency-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-output-new-dependency-light.svg" alt="a.includes changed; b → c. Queries that ran, in printed order: word_count(a), word_count(c), is_haha_number(a). Result: false." width="1400" height="220" loading="lazy" decoding="async">
  </picture>
</p>

We have changed dependencies of `a`, so there is no `b` anymore. So we start with what we know: `word_count` for `a`. It now has a not-yet-tracked dependency on `c`, so we go to `c` _after_ `a`. And the rest is the same.

So I hope you get the idea now: each query result is memorized, and if we discover that the output of this query did not change, we don't need to recompute the queries that depend on this input. Or rather, if _all_ the queries that query X depends on did not change, then query X does not need to be recomputed.

And now imagine that you have 700 dependencies in your workspace. A single file changed in the topmost dependency. 699 dependencies can keep their result! Within a single crate, still only one file has changed, so the information about all  the other files at least partially stays the same. We only need to redo the computations that _actually_ matter.

And most importantly, we don't need to write any of this tracking code ourselves, `Salsa` gives it to us for free.

Convenient? Convenient!

## Inside Salsa

But how does that work?

Well, it's really not trivial. If you want to have a more formal deep dive, I suggest the following reads:

- [Salsa book](https://salsa-rs.netlify.app/reference/algorithm)
- [Queries overview from the Rust Compiler Development Guide](https://rustc-dev-guide.rust-lang.org/query.html) (it's not salsa, but it shares the same idea)

I will give a quick overview.

Imagine that each query, combined with its arguments, is an object. This object can have a bunch of metadata, stating whether it was already computed, when it happened, what was the output, and what's the object dependencies. Let's call this metadata a "memo".

_Side note: why is "combined with its arguments?" important? Because we cannot memoize `is_haha_number`, but we can memoize `is_haha_number(420)`, so you can think of it as a mapping of `(function, arguments) -> output`_

And imagine that you have inputs: something that user provides, and this something can be explicitly requested by a query.

We might also say that the database has a _revision_, initially 1. When you change some input, the revision gets bumped to 2, and so on. This revision can be used as "when it happened" (or rather, "when it change last time") inside of the memo.

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-memos-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-memos-light.svg" alt="Inputs and queries connect to a database at revision 1. Its memo table maps query and key to output and last changed: word_count(a) to 5 and 1, word_count(b) to 3 and 1, and is_haha_number(a) to false and 1." width="1320" height="610" loading="lazy" decoding="async">
  </picture>
</p>

Now, we've provided our inputs and invoke a query. It has some associated code that can internally do two things:

- request another query result
- request an input value.

If query requests an input, it should record that it depends on this input. So if input changes, it must be recomputed.

If query requests another query, we might check if the corresponding query has a memo with a computed value. If it has, we need to make sure that it is valid for the revision we're at. If it is: great! It can be reused, and we don't need to recompute it. Otherwise, we need to recursively go into this query. Obviously, we also record a dependency on this query.

During the execution, we'll collect all the inputs and all the dependency queries, and ultimately we'll finally compute the result of our query. And when we do, we can fill out the memo: record the revision and the output.

And... done! Next time you request an output, we will look at this query object memo. If inputs did not change, we can just hand out the result. If they changed, we go down the query line, and do the same thing. So naturally only the things that _actually_ might have changed will be recomputed.

Oh, but there is one more important detail here, that makes everything _even better_. If revision changed, it does not automatically mean that we need to recompute this query. We might recompute dependencies, and compare them to the old values. If all the outputs are the equal to the old ones (imagine that `word_count(a)` changed from 67 to 69, but `is_haha_number` still returns true `true`: the query that depends on `is_haha_number` might not get invalidated), we can just mark the current version as verified and return the old result. And it can matter a lot when the expensive query has a lot of cheap dependencies.

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-red-green-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-red-green-light.svg" alt="Salsa dependency trees: an equal word count lets the parent reuse its result; a changed count makes the parent recompute." width="1240" height="700" loading="lazy" decoding="async">
  </picture>
</p>

Obviously, it's an overly simplified explanation. In practice, there are many, many caveats, tricky parts, and optimizations that make the experience work well. But my job here is to give you an idea; if you've become interested in the topic, I'd recommend looking to Salsa source code, it's very interesting.

## Enter persistency

And Salsa is _awesome_! With one caveat. It works in memory only. Well, there is ongoing work on persistency there, but AFAIU it is mostly focused on storing the computations on filesystem so that they can be reloaded later (snapshot-like). It is very valuable, but we still have to store stuff in the memory. For the project like Rust Glancer we want to offload stuff to occupy less RAM.

And in practice, there are several projects that do implement various kinds of persistence:

- Well, obviously, Salsa -- you might check out the progress on persistence there.
- `rustc`, though there the logic is highly coupled with the compilation logic. You might look at it for inspiration, but it's not meant for reuse.
- [`picante`](https://github.com/bearcove/dodeca/tree/main/libs/picante). It seems to be like Salsa, but for async Rust. It supports persistence in roughly the same way of global snapshot (de)serialization.
- [`turbo-tasks`](https://github.com/vercel/next.js/tree/canary/turbopack/crates/turbo-tasks) (overview [here](https://nextjs.org/blog/turbopack-incremental-computation)). This one is very interesting, as it has the filesystem cache, which was introduced for basically the same reason: to reduce memory usage. However, it's still built memory-first, and it's built for async workloads. And seemingly, it's [nightly-only](https://github.com/vercel/next.js/blob/canary/turbopack/crates/turbo-tasks/src/lib.rs#L2).
- [`DICE`](https://github.com/meta/buck2/tree/main/dice): an incremental computation engine from Buck2. It's rather low-level, async-first, and also relies on nightly, plus the persistence options are somewhat limited.

So _there are_ solutions for this problem, but none of them seem to be "Salsa but everything is on the filesystem".

I guess then it would be fine to build one?

## Ajika

As you probably guessed, I did build one. And I called it Ajika. And I'm very proud of myself for coming up with this name, yes.

<p>
  <img src="/assets/2026-11-06-persistent-incrementality-in-rust/salsa-ajika-meme.webp" alt="Two-panel meme rejecting Salsa and approving Ajika." width="968" height="760" loading="lazy" decoding="async">
</p>

The library is [here](https://github.com/rust-glancer/ajika), it uses stable Rust, and is generally a complete project (but I'm working on improvements!). The post, however, is not meant to promote it; obviously it's a very young library, and while so far it works really well for me, probably sticking to Salsa if it works for you is a safe choice. Not gonna sell it, do your own research :)

What I want to share is how Ajika works under the hood and what makes it different from Salsa.

But (spoiler) in general it's just two things:
1. data can be loaded on restart (Salsa will also be able to do it eventually, but for Ajika it's basically a side effect), and
2. data is NOT stored in RAM when it's not used. We only load the relevant information for as long as it's needed to execute a query.

And we'll get to it and see how it works, but to make everything clear, we'll need to start from something very basic.

Here's the same program we had for Salsa, but migrated to Ajika:

{% <code_tabs id="ajika-example" label="Ajika implementation" tabs={["queries.rs", "main.rs"]} combined_label="combined"> %}
```rust
use ajika::{Database, Db, Inputs, Result, Retention};
use std::time::Duration;

#[ajika::input(key = String)]
struct File {
    #[input(arc)]
    text: String,
    #[input(arc)]
    includes: Vec<String>,
}

#[ajika::query]
fn word_count(db: &Db<'_>, path: String) -> Result<usize> {
    println!("word_count({path})");

    let file = File::at(path);
    let own = file.text(db)?.split_whitespace().count();

    let mut included = 0;
    for child in file.includes(db)?.iter() {
        included += *word_count(db, child.clone())?;
    }

    Ok(own + included)
}

#[ajika::query]
fn is_haha_number(db: &Db<'_>, path: String) -> Result<bool> {
    println!("is_haha_number({path})");
    Ok(matches!(*word_count(db, path)?, 67 | 69 | 420))
}

```
<!-- tab -->
```rust
fn print_result(database: &mut Database) -> Result<()> {
    let result = database.run(|db| is_haha_number(db, "a".into()))?;
    println!("Result: {}\n", *result);
    Ok(())
}

fn main() -> Result<()> {
    let limits = Retention {
        max_entries: 10_000,
        max_bytes: 256 * 1024 * 1024,
        max_idle: Duration::from_secs(24 * 60 * 60),
    };
    let mut db = Database::open("cache/", "sample-0", Inputs::default(), (), limits).unwrap();

    let a = File::at("a".into());
    let b = File::at("b".into());
    let c = File::at("c".into());

    db.update_inputs(|update| {
        a.set_text(update, "hello world".to_owned())?;
        a.set_includes(update, vec!["b".to_owned()])?;

        b.set_text(update, "one two three".to_owned())?;
        b.set_includes(update, vec![])?;

        c.set_text(update, "not connected".to_owned())?;
        c.set_includes(update, vec![])?;
        Ok(())
    })?;

    print_result(&mut db)?;

    // Change b's text, but preserve its word count.
    db.update_inputs(|u| b.set_text(u, "red blue green".to_owned()))?;
    print_result(&mut db)?;

    // Change b's word count: a now has 67 words.
    db.update_inputs(|u| b.set_text(u, "word ".repeat(65)))?;
    print_result(&mut db)?;

    // a now has 69 words, but is_haha_number is still true.
    db.update_inputs(|u| b.set_text(u, "word ".repeat(67)))?;
    print_result(&mut db)?;

    // Replace a's dependency on b with a dependency on c.
    db.update_inputs(|u| a.set_includes(u, vec!["c".to_owned()]))?;
    print_result(&mut db)?;

    Ok(())
}
```
{% </code_tabs> %}

It looks pretty similar, with API changes mostly being a taste difference, and on a first run it has the same output.

However, the key part here is that we can add the following to the end:

```rust
    let inputs = db.inputs().clone(); // Copy the same inputs we had
    drop(db); // Close the database

    // Reopen the same database
    let mut db = Database::open("cache/", "sample-0", inputs, (), limits).unwrap();
    print_result(&mut db)?;
```

And `print_result` will just print `False`. Nothing will be executed after restart! Persistency in action!

Ma-a-a-a-g-ic! (kinda)

On a serious note, the main difference is the _focus_. When you start working on a project like that, choosing your priority can influence the design a lot. And the choice made here is being _persistent-first_. While Ajika provides an in-memory backend, it's mostly meant for tests. The intended use case is to use your disk.

And it starts with a very basic question that in-memory database does not have: what happens if I restart the application?

If you already have a cache locally, many things can make this cache invalid:
- The app could use a newer version of Ajika which had breaking changes.
- The app could change some queries, so old cache is not usable now.
- Something might have corrupted the cache somehow.
- Yada yada.

And similarly, given that we _cache computations_, it's basically an optimization. If cache gets corrupted or removed while the application is running, user would _most likely_ prefer the cache to be discarded and computations to be repeated one more time, rather than the app crashing with "cache is not available, what do I do???".

As a result, the cache must be _throw-away_. Both Ajika and application supply schema versions to identify the revision, and if the stored cache doesn't match it, we reset it. If cache gets corrupted, Ajika will attempt recovery over hard failing, even if it means re-computing data from scratch. 

The next most noticeable change is that most operations are _fallible_. Since IO is the basic property for us, and IO can fail, we need to think about it. Failed operation does not mean that cache is corrupted, but it does mean that the current query might not be computed. Typically, it can be retried, though.

Finally, the persistence is, unfortunately, a leaky abstraction. You cannot really hide from the fact that the data is outside of memory, because everything you persist must be serializable. And your interim query data might be _reusable_ but not _serializable_ (imagine an AST that borrows the source text: making it own the data likely will be worse), so some of the queries might be _transient_: we compute them once and retain while the current operation runs, but drop instead of persisting once operation ends.

Together, these properties start working rather nicely, however: your application has to be aware of persistence, but not in an annoying way. If something fails, you know about it, but you don't have to worry, since Ajika will repair things for you. If something is not serializable and it doesn't matter, it can be turned into a transient query. If you don't want your tests to rely on persistence, you just plug a memory backend in.

So let's take a look at how it works under the hood.

## Inside Ajika

_LLM usage disclaimer: The library discussed here is developed with use of LLMs, [same as Rust Glancer](https://rust-glancer.github.io/blog/hello-world/#llm-use). Hopefully, from this post it is evident that I'm using LLMs as a tool and have full control. It's not vibe coded._

There are three parts to Ajika: `ajika` itself, `ajika_macros`, and `ajika_storage`.

We'll take a look at `ajika` and then at `ajika_storage`. Macros are left as an exercise to a reader, but they're generally pretty straightforward.

Ajika itself is very easy, just check out this diagram:


<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/ajika-overview-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/ajika-overview-light.svg" alt="Ajika lifecycle: query execution, shared memos, checkpointing, and retention." width="1320" height="1120" loading="lazy" decoding="async">
  </picture>
</p>

...just kidding. But we'll fix that very quickly.

The core idea is very similar to Salsa:

- We have queries that do computations.
- We can provide inputs.
- We have a database that manages query dependencies and remembers stuff for us.

Still, I think it might be useful to skim through the high level details.

_Side note: Ajika has its own [book](https://rust-glancer.github.io/ajika/index.html) which does a much deeper dive on many concepts than this blog post. I'll be referring to it in some places. The con is that, unlike this handwritten blog post, the text there is mostly LLM-generated, and even if I did a lot of polishing, it shows. Eventually I'll do a full manual rewrite, but for now I figured that human-filtered-llm-guide is better than no guide at all._

### Database and queries

[Database](https://docs.rs/ajika/latest/ajika/struct.Database.html) is an entrypoint. You choose either an in-memory or persistent backend, supply [Inputs](https://docs.rs/ajika/latest/ajika/struct.Inputs.html) and then [run](https://docs.rs/ajika/latest/ajika/struct.Database.html#method.run) your operation.

Queries are the actual logic we want to execute. They are defined via [ajika::query](https://docs.rs/ajika/latest/ajika/attr.query.html) macro and in general pretty straightforward. More details on queries themselves are in the [book](https://rust-glancer.github.io/ajika/using/queries.html), and we'll look at how queries are _executed_ and what this `Db` object is a bit later in this post.

### Inputs

Inputs are somewhat more interesting. Your input type is defined through the [ajika::input](https://docs.rs/ajika/latest/ajika/attr.input.html) procedural macro, which would do some wrapping for you. And your `input` structure is basically a mapping: you specify a key, for example, `String`, and then you can use database to get an input value (or lack thereof) for whatever key you have, be it `"foo"` or even `"bar"`. If you have a singleton value, like a config, you can use `()` as a key. Again, more on inputs can be found in the [book](https://rust-glancer.github.io/ajika/using/inputs.html), also might check out [lazy inputs](https://rust-glancer.github.io/ajika/using/lazy-inputs.html).

### Outputs

Outputs are probably the first part of the system that gets interesting because of persistence.

The outputs need to be stored on the filesystem, so they need to be serializable. For outputs that you don't want to serialize, you can use `transient` queries which will keep the value in memory only for the duration of a single operation. But even then, there is a problem: how big of an output do you want?

If you will have a 1000 very granular queries, it will mean that we need a lot of filesystem roundtrips. If you will have just a bunch of queries that compute a ton of data, you will need to deserialize a big value just to look at the part of it.

Thus, outputs offer a solution that lies in between: you can choose to return a value directly, or return a _handle_ to this value. If you return a handle, query can use this handle to retrieve the value from the database on demand. Directly returned values are fully deserialized. This offers you a nice granularity option: you have a query that encapsulates a meaningful unit of work, but it returns you an object that contains handles for particular results. Handle is cheap to obtain and deserialize, and you only query the data you actually need. Doing is most convenient through an [ajika::output](https://docs.rs/ajika/latest/ajika/attr.output.html) macro.

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/ajika-outputs-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/ajika-outputs-light.svg" alt="A directly returned object deserializes A, B, and C before B can be read. A handle object deserializes only its small handles; accessing hB.value(db) then loads and deserializes B, while A and C remain on disk." width="1360" height="810" loading="lazy" decoding="async">
  </picture>
</p>

As usual, more details on how to use outputs are [in the book](https://rust-glancer.github.io/ajika/using/outputs.html).

### Db, Frame, Operation

And now we're getting to the interesting stuff.

To perform a single `run` we need three things:

- `Frame`, which will record the current query metadata; most importantly, reads that it makes.
- `Operation`, which will accumulate the overall changes during a single run.
- `Db`: a context object that holds a `Frame` for the current call, and `Operation` for the current run.

And there are two related concepts that make things work:
- `Memo`: an in-memory state of a query/key execution pair.
- `Record`: part of the memo that can be persisted and removed from memory.

`Record` contains information like values metadata for a query and dependencies for it (note: values are stored separately!).
Thus, `Memo`s are released on the end of the `run` and then later can be reconstructed from `Record` on demand.

**And this is an important bit: released memos don't occupy RAM. This is the key part of Ajika! During the query execution, the values can be loaded, but if you don't run any operations, you don't have to pay for it. Outputs will just wait for you inside of the filesystem! Moreover, whenever we run queries, we only load what we need, not everything.**

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/ajika-ram-lifecycle-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/ajika-ram-lifecycle-light.svg" alt="The first run computes all values in RAM, then saves them to the filesystem and releases the memos. Between runs, RAM is empty. The next run loads only the needed values, while all values remain persisted on disk." width="1280" height="580" loading="lazy" decoding="async">
  </picture>
</p>

Each time a query logic actually runs (either from `run` or from another query), a new `Db` with a new `Frame` is created, sharing the same `Operation`.

When you ask `Db` to execute a query, here's a typical (overly simplified) workflow:

1. Check if the output is recorded in the current `Frame`. If so, just give it out.
2. Get or create a `Memo` for this query in the `Operation`. Note that memo data can be read from the filesystem through the corresponding `Record`.
3. Check if it has an output that can surely be reused. If so, just give it out.
4. If it cannot _surely_ be reused, perform required validation, e.g. check if all the dependencies are the same. If validation passes, give the value out.
5. Finally, the query value is either not computed or not reusable. Create a fresh frame and run the query logic. If this query will invoke any other queries, they will have the same workflow. Save the result value and dependencies in the memo.

And if during execution query receives another query result, it records it in its own `Frame` for reuse.

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/ajika-query-workflow-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/ajika-query-workflow-light.svg" alt="Within one shared Operation, query A checks Frame A, then Memo B(key), then validates dependencies. If execution is needed, B gets a fresh Db and Frame B and records its result and dependencies in its memo. Returning B's value records it and the dependency in Frame A for reuse." width="1100" height="1060" loading="lazy" decoding="async">
  </picture>
</p>

Obviously, there is a lot of bookkeeping, support for parallelism, and other things that make it complex, but in general the algorithm is pretty straightforward.

### Finishing the operation

Once the operation finishes, we need to actually apply the changes. `run` works as a transaction, so everything that was done inside is immediately visible, but after run depending on whether `run` failed or succeeded, the results will either be discarded or persisted.

Checkpoint write is generally pretty straightforward:
- Prepare updates: go through the dirty memos, collect changed values, mark values that are no longer emitted by queries and can be removed, etc.
- Apply updates: actually do the changes, like writing new values to the disk or removing outdated ones.
- Publish changes: _after_ everything is written, make the changes visible to the next run.

So checkpoint on the `Ajika` level is pretty straightforward. What is more interesting is how `Ajika` storage works in general.

### Ajika storage

Finally, we've got to the persistence!

It's probably the most interesting part of Ajika. How do we store data in a way that is efficient?

The first version of Ajika used [`redb`](https://github.com/cberner/redb) for everything. It worked, but it did not work very well. Since we don't really have a "database" per se, and more of a storage for many blobs, `redb` added too much overhead. However, it provides much needed features like transactions.

So, `Ajika` uses `redb` as a _metadata storage_: it's an index which mostly contains pointers to the values.

The values are written in "pack files": basically, just binary files to which we can append new entries. And
inside of `redb` we can just store a pointer: `(file name, offset)`. Each stored entry has a header with information such as length and compression algorithm. For efficiency, if the value is very small, we can keep it inline inside of `redb` instead of writing it to a file.

If you want to access a value, you will go to `redb`, check the corresponding key, and then either read it inline or read the specified pack at the specified access. Pretty simple.

Obviously, there is some more data stored there (we'll talk about identities soon, briefly), but in general it's a pretty "stupid" (hopefully in a good way) format of data storage.

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/assets/2026-11-06-persistent-incrementality-in-rust/ajika-storage-dark.svg" type="image/svg+xml">
    <img src="/assets/2026-11-06-persistent-incrementality-in-rust/ajika-storage-light.svg" alt="Ajika storage: redb index, immutable value packs, and garbage collection." width="1360" height="1220" loading="lazy" decoding="async">
  </picture>
</p>

However, there is one caveat: if we do it naively, the storage can grow without limits. Packs can end up with very low utilization factor, consisting mostly of "dead" values, and some of them might not be observable at all. So the storage supports maintenance: whenever you do an operation, `Ajika` might do a sweep that would re-pack values and update pointers, and at the end of operation `Ajika` will try to signal to the storage which values can be removed now. There are a few knobs you can tune here: you can specify the retention limit time (so that the very old and unused queries are cleaned up) or target storage size (which acts as a soft limit, and will affect the cleanup policy).

But ultimately, this design makes value storing and retrieval pretty efficient, and it integrates with the overall `Ajika` design very well.

### Interner

OK, we're almost done, I promise! The last small bit: interning.

Interning values is an optimization that gives you a way to turn any object into an ID. Imagine that you have file paths. They _can_ work as IDs, but it would probably be more efficient if you used `FileId(0)` / `FileId(1)` instead. Not only in terms of performance, but often also in terms of memory: you'd rather not have a ton of strings in memory if you don't really need them. Sometimes, interning strings on its own can be a very useful memory optimization, which is why crates like [`string_cache`](https://docs.rs/string_cache/latest/string_cache/) exist.

But for us, having IDs for objects can be valuable in general, because your computations results might often be linked to some other objects, and it's useful to be able to use IDs for that.

Salsa supports interning for that purpose, and Ajika does it too. However, there is one caveat for Ajika: what happens if we have our IDs allocated, they become a part of the cache, and then we restart the application?

To avoid this problem, IDs in Ajika are persisted in addition to being stored in memory, and on restart this interner state is reloaded.

## Is it worth it?

Ajika development itself was an experiment: I did not create it in vacuum, I was actually porting Rust Glancer to it at the same time. And the experiment was _very_ successful. I was able to remove a lot of complexity from Rust Glancer, and Ajika unblocked many optimizations that were not realistic with hand-rolled caches (starting with lazy body evaluation).

At the end of the experiment, Rust Glancer got performance comparable to rust-analyzer (sometimes even better!). Ajika is obviously slower than salsa, but inside of IDE the difference between 1 and 30ms is negligible, both feel instant. What matters is the low RAM usage: Rust Glancer still stays well under 100MB RAM idle on pretty big projects.

_Remark: exact comparison between two will be posted in the release notes for Rust Glancer 0.5.0, so stay tuned._

As the experiments go, the branch of Rust Glancer where all of that happened is in a half-assembled state, and it's way too rushed and "prototyped" to just merge it, so I'm doing a clean reimplementation using extracted (and published) version of Ajika. It will take a while, but I'm very excited: Rust Glancer without compromises that feels instant and does not eat memory.

So yeah, it is _very_ worth it!

## That's all

Thanks for reading, it turned out to be a long post. A lot of effort went into it, so I hope that it was useful, at least somewhat.

My next goal is to prepare an Ajika-based release of Rust Glancer, and after that I have a lot of ideas on how to make Ajika even faster/better/stronger. Who knows, maybe it will eventually grow into a product of its own, not merely a part of Rust Glancer ecosystem.

As usual, the best way to support if you like the project is to [check out Rust Glancer](https://github.com/rust-glancer/rust-glancer), [star Ajika](https://github.com/rust-glancer/ajika) (but only if you like it!) and/or [follow me on twitter](https://x.com/popzxc_is_me).

See ya!
