# Manim Plugin for Obsidian

Create and edit **Manim animations** directly in your Obsidian notes with a live editor, instant rendering, and full TypeScript support. Powered by **[manim-web](https://github.com/maloyan/manim-web)**.

## Features

- **Inline Editor**: Embedded CodeMirror editor with syntax highlighting, supporting TypeScript annotations
- **Live Preview**: Render animations instantly inside your notes
- **Auto-save**: Changes automatically persist to your markdown source
- **Theme Selector**: Choose from 5 color themes (GitHub Light/Dark, Monokai, One Dark, Obsidian)
- **Error Debugging**: Detailed error panels with full stack traces for quick troubleshooting
- **TypeScript Support**: Write TS annotations in manim code (automatically transpiled)
- **Dual Syntax Support**: Write scenes as modern functions or classic Manim classes
- **Responsive Design**: Beautiful, fully-responsive layout for desktop and mobile

## Quick Start

### 1. Install the plugin
- Search for "Manim Plugin" in Obsidian's community plugins
- Click **Install** and **Enable**

### 2. Create a manim code block
Write in your markdown:

````markdown
```manim
import { Scene, Circle, Create } from 'manim-web';

export async function myScene(scene: Scene) {
  const circle = new Circle({ radius: 2 });
  await scene.play(new Create(circle));
}
```
````

### 3. Edit and render
- Click **Run** in the block header to render
- Edit code directly in the embedded editor
- Changes auto-save to markdown

## Syntax & Formats

The API is powered by **[manim-web](https://github.com/maloyan/manim-web)**. You can write your animations in either of two supported formats:

### Format A: Function-Based Scenes (Recommended)
This format is the modern standard for `manim-web` and is the default output format when converting Python Manim scripts using `py2ts.cjs`.

```ts
import { Scene, Circle, Create, GREEN } from 'manim-web';

export async function myScene(scene: Scene) {
  const circle = new Circle({ color: GREEN });
  await scene.play(new Create(circle));
  await scene.wait(1);
}
```

### Format B: Class-Based Scenes (Classic Manim Style)
Follows Python Manim's traditional object-oriented style by extending `Scene` and implementing `construct()`:

```ts
import { Scene, Circle, Create, GREEN } from 'manim-web';

export default class MyScene extends Scene {
  async construct() {
    const circle = new Circle({ color: GREEN });
    await this.play(new Create(circle));
    await this.wait(1);
  }
}
```

### Imports
Always import components directly from `'manim-web'`:
```ts
import { Scene, Circle, Square, Line, Create, Transform, FadeOut, BLUE, RED } from 'manim-web';
```

## Converting Python Manim to TypeScript

You can convert existing Python Manim scripts to Obsidian-compatible TypeScript using `py2ts.cjs` from [manim-web](https://github.com/maloyan/manim-web/blob/main/tools/py2ts.cjs):

```bash
node py2ts.cjs my_script.py
```

The output can be directly pasted into an Obsidian ` ```manim ` code block.

## Settings

**Editor Theme**
- Obsidian (default, synced with your vault's theme)
- GitHub Light / Dark
- Monokai  
- One Dark

Access via **Settings → Community Plugins → Manim Plugin**.

## TypeScript Support

Use TypeScript annotations in your code – they are automatically transpiled on the fly:

```ts
import { Scene } from 'manim-web';

export default class Example extends Scene {
  async construct() {
    const radius: number = 2.5;
    const label: string = "animation";
  }
}
```

## Troubleshooting

**Code won't render?**
- Check the **Error Panel** below the canvas for detailed stack traces
- Ensure your code exports an async scene function (`export async function myScene(scene: Scene)`) or a default class extending `Scene` (`export default class ... extends Scene`)
- Verify that your imports come from `'manim-web'` (`import { ... } from 'manim-web';`)

**Style issues?**
- Your editor style syncs from Obsidian's native CodeMirror
- Try changing themes in settings if it doesn't match your vault theme

**Performance?**
- Large animations can be slow on low-end devices
- Simpler scenes render faster; test with small examples first

## Development

Built with:
- **[CodeMirror 6](https://codemirror.net/)** – advanced code editor
- **[manim-web](https://github.com/maloyan/manim-web)** – mathematical animation library for the web
- **Obsidian Plugin API**

## Roadmap

- [ ] **Auto-completions** for manim-web API (Scene, Circle, animations, colors)
- [ ] **Demo screenshots & GIFs** showcasing editor, rendering, and themes
- [ ] Improved cursor handling in code editor
- [ ] Export animations to HTML/MP4

quick test