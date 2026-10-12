/** Synthetic, complete authored sources shared by real-renderer and export
 * qualification. A fixture is never repaired or rewritten before rendering:
 * its original bytes must remain available through the Source/Copy controls. */
export interface MermaidFamilyFixture {
  readonly family: string;
  readonly source: string;
  readonly labels: readonly string[];
  /** Retained native SVG drawing, independently of title/label text. */
  readonly geometry: readonly { readonly selector: string; readonly minimum: number }[];
}

export const MERMAID_FAMILY_FIXTURES: readonly MermaidFamilyFixture[] = [
  {
    family: "journey",
    source: `journey
    title Create a Diagram
    section Prepare
        Open editor: 5: User
        Choose diagram type: 4: User
    section Build
        Write source: 3: User
        Preview diagram: 5: User, Renderer
    section Share
        Export result: 4: User`,
    labels: [
      "Create a Diagram",
      "Open editor",
      "Choose diagram type",
      "Write source",
      "Preview diagram",
      "Export result",
      "User",
      "Renderer",
    ],
    geometry: [
      { selector: "rect", minimum: 5 },
      { selector: "circle", minimum: 5 },
    ],
  },
  {
    family: "quadrantChart",
    source: `quadrantChart
    title Feature Priorities
    x-axis Low effort --> High effort
    y-axis Low impact --> High impact
    quadrant-1 Strategic projects
    quadrant-2 Quick wins
    quadrant-3 Small improvements
    quadrant-4 Reconsider
    Better labels: [0.20, 0.75]
    New layout engine: [0.80, 0.90]
    Spacing adjustment: [0.15, 0.20]
    Decorative animation: [0.75, 0.25]`,
    labels: [
      "Feature Priorities",
      "Strategic projects",
      "Quick wins",
      "Small improvements",
      "Reconsider",
      "Better labels",
      "New layout engine",
      "Spacing adjustment",
      "Decorative animation",
    ],
    geometry: [
      { selector: "rect", minimum: 4 },
      { selector: "circle", minimum: 4 },
    ],
  },
  {
    family: "requirementDiagram",
    source: `requirementDiagram
    requirement render_requirement {
        id: R1
        text: Valid diagrams must render.
        risk: medium
        verifymethod: test
    }
    functionalRequirement export_requirement {
        id: R2
        text: Rendered diagrams must support export.
        risk: low
        verifymethod: demonstration
    }
    element renderer {
        type: software
        docref: Renderer specification
    }
    renderer - satisfies -> render_requirement
    export_requirement - refines -> render_requirement`,
    labels: [
      "render_requirement",
      "export_requirement",
      "renderer",
      "Valid diagrams must render.",
      "Rendered diagrams must support export.",
      "satisfies",
      "refines",
    ],
    geometry: [
      { selector: "rect", minimum: 3 },
      { selector: "path", minimum: 2 },
    ],
  },
  {
    family: "gitGraph horizontal merge",
    source: `gitGraph
    commit id: "initial"
    branch feature
    checkout feature
    commit id: "add-diagram"
    commit id: "polish"
    checkout main
    commit id: "maintenance"
    merge feature
    commit id: "release" tag: "v1.0"`,
    labels: [
      "initial",
      "add-diagram",
      "polish",
      "maintenance",
      "release",
      "v1.0",
      "feature",
      "main",
    ],
    geometry: [
      { selector: "circle", minimum: 6 },
      { selector: "path", minimum: 2 },
    ],
  },
  {
    family: "gitGraph vertical cherry-pick",
    source: `gitGraph TB:
    commit id: "start"
    branch fix
    checkout fix
    commit id: "patch"
    checkout main
    cherry-pick id: "patch"
    commit id: "ship"`,
    labels: ["start", "patch", "ship", "main", "fix"],
    geometry: [
      { selector: "circle", minimum: 4 },
      { selector: "path", minimum: 2 },
    ],
  },
  {
    family: "mindmap",
    source: `mindmap
    root((Mermaid testing))
        Basics
            Shapes
            Labels
            Arrows
        Charts
            Pie
            Radar
            XY
        Architecture
            C4
            Deployment
        Compatibility
            Versions
            Extensions`,
    labels: [
      "Mermaid testing",
      "Shapes",
      "Labels",
      "Arrows",
      "Pie",
      "Radar",
      "XY",
      "C4",
      "Deployment",
      "Versions",
      "Extensions",
    ],
    geometry: [{ selector: "path", minimum: 14 }],
  },
  {
    family: "timeline",
    source: `timeline
    title Example Release History
    section Prototype
        2026-01 : Wireframes : Clickable demo
        2026-03 : First renderer
    section Launch
        2026-06 : Public preview
        2026-10 : Stable release : Export support`,
    labels: [
      "Example Release History",
      "Prototype",
      "Launch",
      "2026-01",
      "Wireframes",
      "Clickable demo",
      "First renderer",
      "Public preview",
      "Stable release",
      "Export support",
    ],
    geometry: [{ selector: "path", minimum: 4 }],
  },
  {
    family: "sankey-beta",
    source: `sankey-beta

Visitors,Editor,80
Visitors,Documentation,20
Editor,Export,50
Editor,Preview,30
Documentation,Preview,20`,
    labels: ["Visitors", "Editor", "Documentation", "Export", "Preview"],
    geometry: [
      { selector: "rect", minimum: 5 },
      { selector: "path", minimum: 5 },
    ],
  },
  {
    family: "block-beta",
    source: `block-beta
    columns 3
    A["Input"] B["Transform"] C["Output"]
    space:3
    D["Storage"]:3
    A --> B
    B --> C
    B --> D
    style D fill:#dbeafe,stroke:#2563eb,color:#111827`,
    labels: ["Input", "Transform", "Output", "Storage"],
    geometry: [
      { selector: "rect", minimum: 4 },
      { selector: "path", minimum: 3 },
    ],
  },
  {
    family: "packet-beta absolute offsets",
    source: `packet-beta
    0-7: "Version"
    8-15: "Flags"
    16-31: "Length"
    32-63: "Request ID"
    64-95: "Payload"`,
    labels: ["Version", "Flags", "Length", "Request ID", "Payload"],
    geometry: [{ selector: "rect", minimum: 5 }],
  },
  {
    family: "packet relative lengths",
    source: `packet
    title Example Message
    +8: "Type"
    +8: "Flags"
    +16: "Length"
    +32: "Sequence"
    +32: "Payload"`,
    labels: ["Example Message", "Type", "Flags", "Length", "Sequence", "Payload"],
    geometry: [{ selector: "rect", minimum: 5 }],
  },
  {
    family: "kanban",
    source: `kanban
    backlog[Backlog]
        labels[Improve labels]
        layouts[Add layouts]
    doing[In progress]
        parser[Parse updates]@{ assigned: "Alex", priority: "High" }
    review[Review]
        export[SVG export]@{ assigned: "Sam" }
    complete[Done]
        preview[Live preview]`,
    labels: [
      "Backlog",
      "Improve labels",
      "Add layouts",
      "In progress",
      "Parse updates",
      "Alex",
      "Review",
      "SVG export",
      "Sam",
      "Done",
      "Live preview",
    ],
    geometry: [{ selector: "rect", minimum: 9 }],
  },
  {
    family: "architecture-beta",
    source: `architecture-beta
    group platform(cloud)[Platform]
    service app(server)[Application] in platform
    service db(database)[Database] in platform
    service files(disk)[Files] in platform
    service client(internet)[Client]
    client:R --> L:app
    app:R --> L:db
    app:B --> T:files`,
    labels: ["Platform", "Application", "Database", "Files", "Client"],
    geometry: [{ selector: "path", minimum: 3 }],
  },
  {
    family: "radar-beta",
    source: `radar-beta
    title Renderer Comparison
    axis speed["Speed"], fidelity["Fidelity"], coverage["Coverage"], usability["Usability"]
    curve current["Current"]{7, 8, 5, 8}
    curve proposed["Proposed"]{8, 9, 9, 7}
    min 0
    max 10
    graticule polygon`,
    labels: [
      "Renderer Comparison",
      "Speed",
      "Fidelity",
      "Coverage",
      "Usability",
      "Current",
      "Proposed",
    ],
    geometry: [{ selector: "polygon, path", minimum: 2 }],
  },
  {
    family: "treemap-beta",
    source: `treemap-beta
    "Diagram Usage"
        "Processes"
            "Flowcharts": 40
            "Sequences": 25
        "Models"
            "Classes": 15
            "Entities": 10
        "Charts"
            "Pie": 6
            "Radar": 4`,
    labels: [
      "Diagram Usage",
      "Processes",
      "Flowcharts",
      "Sequences",
      "Models",
      "Classes",
      "Entities",
      "Charts",
      "Pie",
      "Radar",
    ],
    geometry: [{ selector: "rect", minimum: 6 }],
  },
  {
    family: "swimlane-beta",
    source: `swimlane-beta LR
    subgraph requester[Requester]
        A([Submit request])
        E[Receive result]
    end
    subgraph reviewer[Reviewer]
        B[Review request]
        C{Approved?}
    end
    subgraph operator[Operator]
        D[Complete work]
    end
    A --> B --> C
    C -->|Yes| D
    D --> E`,
    labels: [
      "Requester",
      "Reviewer",
      "Operator",
      "Submit request",
      "Receive result",
      "Review request",
      "Approved?",
      "Complete work",
      "Yes",
    ],
    geometry: [
      { selector: "rect, polygon", minimum: 5 },
      { selector: "path", minimum: 5 },
    ],
  },
  {
    family: "usecase-beta",
    source: `usecase-beta
    direction LR
    actor Member("Member")
    actor Administrator("Administrator")
    systemBoundary workspace["Workspace"]
        Create("Create diagram")
        Export("Export diagram")
        Manage("Manage settings")
        Validate("Validate source")
    end
    Member --> Create
    Member --> Export
    Administrator --> Manage
    Create ..> : include Validate`,
    labels: [
      "Member",
      "Administrator",
      "Workspace",
      "Create diagram",
      "Export diagram",
      "Manage settings",
      "Validate source",
      "include",
    ],
    geometry: [
      { selector: "ellipse", minimum: 4 },
      { selector: "path, line", minimum: 4 },
    ],
  },
  {
    family: "eventmodeling",
    source: `eventmodeling

tf 01 ui TaskForm
tf 02 cmd CreateTask { title: string }
tf 03 evt TaskCreated { title: string }
tf 04 rmo TaskList ->> 03`,
    labels: ["TaskForm", "CreateTask", "TaskCreated", "TaskList", "title: string"],
    geometry: [
      { selector: "rect", minimum: 4 },
      { selector: "path, line", minimum: 1 },
    ],
  },
  {
    family: "venn-beta",
    source: `venn-beta
    title Team Skills
    set Design
    set Engineering
    set Research
    union Design,Engineering["Prototyping"]
    union Engineering,Research["Experiments"]
    union Design,Research["Discovery"]
    union Design,Engineering,Research["Product"]`,
    labels: [
      "Team Skills",
      "Design",
      "Engineering",
      "Research",
      "Prototyping",
      "Experiments",
      "Discovery",
      "Product",
    ],
    geometry: [{ selector: "circle, path", minimum: 3 }],
  },
  {
    family: "ishikawa-beta",
    source: `ishikawa-beta
    Slow Rendering
    Input
        Large diagrams
        Long labels
    Layout
        Dense connections
        Nested groups
    Environment
        Limited memory
        Busy processor
    Output
        Complex styling
        Many SVG elements`,
    labels: [
      "Slow Rendering",
      "Input",
      "Large diagrams",
      "Long labels",
      "Layout",
      "Dense connections",
      "Nested groups",
      "Environment",
      "Limited memory",
      "Busy processor",
      "Output",
      "Complex styling",
      "Many SVG elements",
    ],
    geometry: [{ selector: "path, line", minimum: 9 }],
  },
  {
    family: "wardley-beta",
    source: `wardley-beta
    title Diagram Service Value Chain
    anchor User [0.95, 0.60]
    component Editor [0.80, 0.50]
    component Renderer [0.60, 0.45]
    component Storage [0.30, 0.80]
    component Compute [0.15, 0.90]
    User -> Editor
    Editor -> Renderer
    Editor -> Storage
    Renderer -> Compute
    evolve Renderer 0.70`,
    labels: ["Diagram Service Value Chain", "User", "Editor", "Renderer", "Storage", "Compute"],
    geometry: [
      // The pinned native renderer draws an anchor as its labelled node group,
      // not a component circle. Retain all five authored identities and require
      // both the four component drawings and the distinct anchor label.
      { selector: ".wardley-nodes .wardley-node", minimum: 5 },
      { selector: ".wardley-node:not(.wardley-node--anchor) > circle", minimum: 4 },
      { selector: ".wardley-node--anchor > .wardley-node-label", minimum: 1 },
      { selector: "path, line", minimum: 4 },
    ],
  },
  {
    family: "cynefin-beta",
    source: `cynefin-beta
    title Troubleshooting Decisions
    complex
        "Explore intermittent failures"
    complicated
        "Analyze layout performance"
    clear
        "Correct a syntax error"
    chaotic
        "Restore a failed service"
    confusion
        "Identify the failure category"`,
    labels: [
      "Troubleshooting Decisions",
      "Explore intermittent failures",
      "Analyze layout performance",
      "Correct a syntax error",
      "Restore a failed service",
      "Identify the failure category",
    ],
    geometry: [{ selector: "path, polygon, rect", minimum: 5 }],
  },
  {
    family: "treeView-beta",
    source: `treeView-beta
    src/
        index.js
        App.tsx
    package.json`,
    labels: ["index.js", "App.tsx", "package.json"],
    geometry: [{ selector: "path, line", minimum: 3 }],
  },
  {
    family: "agentflow-beta",
    source: `agentflow-beta LR
    brief["Brief"]@{ shape: input }
    draft["Draft copy"]@{ shape: task }
    spellcheck["spell_check"]@{ shape: tool }
    guide["Style guide"]@{ shape: refdoc }
    publish["Publish"]@{ shape: action }
    brief --> draft --> spellcheck --> publish
    draft -.- guide`,
    labels: ["Brief", "Draft copy", "spell_check", "Style guide", "Publish"],
    geometry: [
      { selector: "path", minimum: 5 },
      { selector: "rect, polygon, path", minimum: 5 },
    ],
  },
  {
    family: "C4Context",
    source: `C4Context
    Person(user, "User")
    System(app, "Application")
    Rel(user, app, "Uses")`,
    labels: ["User", "Application", "Uses"],
    geometry: [
      { selector: "rect", minimum: 2 },
      { selector: "path, line", minimum: 1 },
    ],
  },
  {
    family: "C4Container",
    source: `C4Container
    Container(app, "Application", "TypeScript")
    System(db, "Database")
    Rel(app, db, "Reads")`,
    labels: ["Application", "TypeScript", "Database", "Reads"],
    geometry: [
      { selector: "rect", minimum: 2 },
      { selector: "path, line", minimum: 1 },
    ],
  },
  {
    family: "C4Component",
    source: `C4Component
    Component(app, "Application", "TypeScript")
    Component(db, "Database", "SQL")
    Rel(app, db, "Reads")`,
    labels: ["Application", "TypeScript", "Database", "SQL", "Reads"],
    geometry: [
      { selector: "rect", minimum: 2 },
      { selector: "path, line", minimum: 1 },
    ],
  },
  {
    family: "C4Dynamic",
    source: `C4Dynamic
    Person(user, "User")
    System(app, "Application")
    Rel(user, app, "Uses")`,
    labels: ["User", "Application", "Uses"],
    geometry: [
      { selector: "rect", minimum: 2 },
      { selector: "path, line", minimum: 1 },
    ],
  },
  {
    family: "C4Deployment",
    source: `C4Deployment
    Deployment_Node(server, "Server") {
        Container(app, "Application", "TypeScript")
    }`,
    labels: ["Server", "Application", "TypeScript"],
    geometry: [{ selector: "rect", minimum: 2 }],
  },
  {
    family: "railroad-beta",
    source: `railroad-beta
rule = sequence(terminal("alpha"), terminal("beta")) ;`,
    labels: ["alpha", "beta"],
    geometry: [
      { selector: "rect", minimum: 2 },
      { selector: "path", minimum: 2 },
    ],
  },
  {
    family: "railroad-ebnf-beta",
    source: `railroad-ebnf-beta
rule = "alpha" "beta" ;`,
    labels: ["alpha", "beta"],
    geometry: [
      { selector: "rect", minimum: 2 },
      { selector: "path", minimum: 2 },
    ],
  },
  {
    family: "railroad-abnf-beta",
    source: `railroad-abnf-beta
rule = "alpha" "beta" ;`,
    labels: ["alpha", "beta"],
    geometry: [
      { selector: "rect", minimum: 2 },
      { selector: "path", minimum: 2 },
    ],
  },
  {
    family: "railroad-peg-beta",
    source: `railroad-peg-beta
rule <- "alpha" "beta" ;`,
    labels: ["alpha", "beta"],
    geometry: [
      { selector: "rect", minimum: 2 },
      { selector: "path", minimum: 2 },
    ],
  },
];
