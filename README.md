# rust-glancer.github.io

Website for [rust glancer](https://github.com/rust-glancer/rust-glancer).

## Local development

```sh
zola serve
```

## Callouts

Use GitHub-style alerts in Markdown. `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, and
`CAUTION` share a shaded background and blue left border in light and dark mode.
Add a bold label for a custom title:

```markdown
> [!NOTE]
> **Disclaimer**
>
> Some explanations are intentionally simplified. Follow the linked resources
> for more precise explanations.
```

## Tabbed code examples

Set `extra.code_tabs = true` in the page front matter. Give `code_tabs` a unique
`id`, an accessible `label`, and an explicit name for each fenced code block in
`tabs`. Separate the blocks with `<!-- tab -->`:

````markdown
{% <code_tabs id="example" label="Example implementation" tabs={["helpers.rs", "app.rs"]} combined_label="Full example"> %}
```rust
fn answer() -> usize {
    42
}

```
<!-- tab -->
```rust
fn main() {
    println!("{}", answer());
}
```
{% </code_tabs> %}
````

The first tab is selected initially. Any number of tabs and any fenced code
language are supported. Optionally supply `combined_label` to add a named view
that concatenates blocks in the same language, without duplicating their source.
Printing and browsers without JavaScript show that combined view, or all labeled
blocks when no combined view was requested.

## Validation

```sh
zola check
zola build
```

## License

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.
