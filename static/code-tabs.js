document.querySelectorAll(".code-tabs").forEach((example) => {
  const tablist = example.querySelector('[role="tablist"]');
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  const panels = Array.from(example.querySelectorAll('[role="tabpanel"]'));

  const select = (index, moveFocus = false) => {
    tabs.forEach((tab, current) => {
      const selected = current === index;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[current].hidden = !selected;
    });
    if (moveFocus) tabs[index].focus();
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(index));
    tab.addEventListener("keydown", (event) => {
      let next;
      switch (event.key) {
        case "ArrowLeft":
          next = (index + tabs.length - 1) % tabs.length;
          break;
        case "ArrowRight":
          next = (index + 1) % tabs.length;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = tabs.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      select(next, true);
    });
  });

  select(0);
  example.dataset.enhanced = "";
  tablist.hidden = false;
});
