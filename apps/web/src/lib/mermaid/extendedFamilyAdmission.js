// Loaded only as inert source into Cafe's opaque-origin Mermaid frame. These
// adapters are intentionally tied to Mermaid 12.0.0 at immutable upstream
// 98a0945418c76238f15df2afaddbba4272656c3b. Never import this into the app realm.
// A future database/renderer shape must be reviewed, not treated as zero work.
(() => {
  const LIMIT = 250;
  const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
  const fail = () => {
    throw new Error();
  };
  const record = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    return value;
  };
  const array = (value) => {
    if (!Array.isArray(value) || value.length > LIMIT) fail();
    return value;
  };
  const map = (value) => {
    if (!(value instanceof Map) || value.size > LIMIT) fail();
    return value;
  };
  const text = (value) => {
    if (typeof value !== "string" || value.length > 32768) fail();
    return value;
  };
  const optionalText = (value) => {
    if (value != null) text(value);
  };
  const id = (value) => {
    text(value);
    if (!value || reserved.has(value)) fail();
    return value;
  };
  const finite = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) fail();
    return value;
  };
  const integer = (value, min = 0, max = LIMIT) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail();
    return value;
  };
  const unit = (value) => {
    finite(value);
    if (value < 0 || value > 1) fail();
  };
  const percent = (value) => {
    finite(value);
    if (value < 0 || value > 100) fail();
  };
  const bounded = (nodes, edges) => {
    integer(nodes, 1);
    integer(edges);
    return [nodes, edges];
  };
  const passive = (value) => {
    record(value);
    // Independent of lexical spelling: parsed images/icons/links must not
    // initiate resource acquisition, or disappear silently in inert output.
    if (
      value.img != null ||
      value.icon != null ||
      value.link != null ||
      value.shape === "image" ||
      value.shape === "imageSquare" ||
      value.shape === "icon" ||
      value.shape === "usecaseActorIcon"
    )
      fail();
  };
  const forest = (parents) => {
    // Validate containment before native recursive layout/accessors. Ordinary
    // graph cycles are allowed; only parent-child cycles are unsafe here.
    for (const start of parents.keys()) {
      const seen = new Set();
      let current = start;
      while (current != null && current !== "") {
        if (seen.has(current) || !parents.has(current)) fail();
        seen.add(current);
        current = parents.get(current);
      }
    }
  };
  const layout = (db) => {
    const graph = record(db.getData());
    const nodes = array(graph.nodes);
    const edges = array(graph.edges);
    const names = new Set();
    const parents = new Map();
    for (const node of nodes) {
      passive(node);
      const name = id(node.id);
      if (names.has(name)) fail();
      names.add(name);
      optionalText(node.label);
      if (node.parentId != null) id(node.parentId);
      parents.set(name, node.parentId);
      if (node.jsonRows != null) fail();
    }
    forest(parents);
    let edgeRanks = 0;
    for (const edge of edges) {
      passive(edge);
      if (!names.has(id(edge.start)) || !names.has(id(edge.end))) fail();
      if (edge.minlen != null) integer(edge.minlen, 0);
      // Dagre expands minimum-rank spans into intermediate layout work. A
      // per-edge bound alone would admit 250 edges each spanning 250 ranks.
      // Bound their aggregate before any renderer/layout can create dummies.
      edgeRanks += Math.max(1, edge.minlen ?? 1);
      if (edgeRanks > LIMIT) fail();
      optionalText(edge.label);
      // Animation is not represented by Cafe's output policy. A still image
      // should not claim to preserve an authored animated relationship.
      if (edge.animate || edge.animation != null) fail();
    }
    return bounded(nodes.length, edges.length);
  };
  const tree = (root, inspect) => {
    const seen = new Set();
    const pending = [[root, 0]];
    let edges = 0;
    while (pending.length) {
      const [node, depth] = pending.pop();
      record(node);
      // A modest depth bound avoids the recursive native renderers' stack
      // amplification, independently of the aggregate item/source limits.
      if (seen.has(node) || depth > 64) fail();
      seen.add(node);
      if (seen.size > LIMIT) fail();
      inspect(node);
      const children = array(node.children);
      edges += children.length;
      if (edges > LIMIT) fail();
      for (const child of children) pending.push([child, depth + 1]);
    }
    return bounded(seen.size, edges);
  };
  const mindmap = (db) =>
    tree(db.getMindmap(), (node) => {
      integer(node.id);
      text(node.nodeId);
      text(node.descr);
      integer(node.type, 0, 6);
      integer(node.level, 0, 32768);
      if (node.icon != null) fail();
    });
  const treeView = (db) => {
    const result = tree(db.getRoot(), (node) => {
      integer(node.id);
      text(node.name);
      optionalText(node.description);
      if (node.nodeType !== "file" && node.nodeType !== "directory") fail();
      // These two original bundled glyphs do not fetch an Iconify pack. An
      // explicit custom pack remains source-only rather than a missing glyph.
      if (
        node.icon != null &&
        !["none", "file", "folder", "mermaid-treeview:file", "mermaid-treeview:folder"].includes(
          node.icon,
        )
      )
        fail();
    });
    if (integer(db.getCount(), 1) !== result[0]) fail();
    return result;
  };
  const architecture = (db) => {
    const nodes = array(db.getNodes());
    const groups = array(db.getGroups());
    const edges = array(db.getEdges());
    const hints = array(db.getLayoutHints());
    const parents = new Map();
    const names = new Set();
    const nodeNames = new Set();
    const adjacency = new Map();
    const incident = new Map();
    const icons = new Set(["cloud", "database", "disk", "internet", "server", "blank"]);
    for (const item of [...groups, ...nodes]) {
      record(item);
      const name = id(item.id);
      if (names.has(name)) fail();
      names.add(name);
      if (item.in != null) id(item.in);
      parents.set(name, item.in);
      optionalText(item.title);
      if (item.iconText != null) fail(); // Native iconText is a foreignObject.
      if (item.icon != null) {
        const icon = text(item.icon).replace(/^mermaid-architecture:/, "");
        if (!icons.has(icon)) fail();
      }
    }
    forest(parents);
    const groupNames = new Set(groups.map((group) => group.id));
    for (const item of [...groups, ...nodes])
      if (item.in != null && !groupNames.has(item.in)) fail();
    for (const node of nodes) {
      if (node.type !== "service" && node.type !== "junction") fail();
      array(node.edges);
      nodeNames.add(node.id);
      adjacency.set(node.id, new Map());
      incident.set(node.id, []);
    }
    for (const edge of edges) {
      record(edge);
      const left = id(edge.lhsId);
      const right = id(edge.rhsId);
      if (!nodeNames.has(left) || !nodeNames.has(right)) fail();
      if (
        !["L", "R", "T", "B"].includes(edge.lhsDir) ||
        !["L", "R", "T", "B"].includes(edge.rhsDir)
      )
        fail();
      optionalText(edge.title);
      // The native allocating getter traverses each service's incident list,
      // not the separate global edge list. Bind both views by exact object and
      // insertion order before using the global list to predict its BFS work.
      // A self-edge legitimately appears twice in that service's native list.
      incident.get(left).push(edge);
      incident.get(right).push(edge);
      if (edge.lhsDir !== edge.rhsDir) {
        // Mirror native direction-key overwrite order, not an abstract graph
        // approximation: getDataStructures() uses the last edge for a pair.
        adjacency.get(left).set(edge.lhsDir + edge.rhsDir, right);
        // Native chooses its lhs branch for both incident visits of a self-
        // edge. Inventing its reverse key could overwrite a real neighbor in
        // this predictor and undercount the native duplicate-dequeue walk.
        if (right !== left) adjacency.get(right).set(edge.rhsDir + edge.lhsDir, left);
      }
    }
    for (const node of nodes) {
      const actual = array(node.edges);
      const expected = incident.get(node.id);
      if (actual.length !== expected.length) fail();
      for (let index = 0; index < actual.length; index++)
        if (actual[index] !== expected[index]) fail();
    }
    let members = 0;
    for (const hint of hints) {
      record(hint);
      if (hint.direction !== "row" && hint.direction !== "column") fail();
      const group = array(hint.members);
      if (group.length < 2 || new Set(group).size !== group.length) fail();
      for (const name of group) if (!nodeNames.has(id(name))) fail();
      members += group.length;
      if (members > LIMIT) fail();
    }
    // Native BFS marks visited at dequeue and does not skip duplicate dequeued
    // nodes. Reconvergent layered graphs can amplify its queue exponentially.
    // Bound the actual predicted insertions before that native accessor runs.
    const visited = new Set();
    let queued = 0;
    for (const start of nodeNames) {
      if (visited.has(start)) continue;
      const queue = [start];
      if (++queued > LIMIT) fail();
      for (let index = 0; index < queue.length; index++) {
        const name = queue[index];
        visited.add(name);
        for (const neighbor of adjacency.get(name).values()) {
          if (!visited.has(neighbor)) {
            if (++queued > LIMIT) fail();
            queue.push(neighbor);
          }
        }
      }
    }
    return bounded(nodes.length + groups.length + hints.length + members, edges.length);
  };
  const c4 = (db) => {
    const shapes = array(db.getC4ShapeArray());
    const boundaries = array(db.getBoundaries());
    const relations = array(db.getRels());
    integer(db.getC4ShapeInRow(), 1);
    integer(db.getC4BoundaryInRow(), 1);
    const parents = new Map();
    const names = new Set();
    for (const item of [...boundaries, ...shapes]) {
      record(item);
      const name = id(item.alias);
      if (names.has(name)) fail();
      names.add(name);
      text(record(item.label).text);
      text(item.parentBoundary);
      parents.set(name, item.parentBoundary);
      // Sprite resources are not part of the local image renderer. Named
      // $link attributes must be caught here even without a link directive.
      if (item.sprite || item.legendSprite || item.link) fail();
      for (const field of ["descr", "techn", "type"])
        if (item[field] != null) text(record(item[field]).text);
    }
    forest(parents);
    for (const relation of relations) {
      record(relation);
      if (!names.has(id(relation.from)) || !names.has(id(relation.to))) fail();
      text(record(relation.label).text);
      if (relation.sprite || relation.link) fail();
      for (const field of ["offsetX", "offsetY"])
        if (relation[field] != null && Math.abs(finite(relation[field])) > 10000) fail();
    }
    return bounded(shapes.length + boundaries.length, relations.length);
  };
  const agentflow = (db) => {
    const vertices = map(db.getVertices());
    const groups = array(db.getSubGraphs());
    const edges = array(db.getEdges());
    const parents = new Map();
    for (const [name, vertex] of vertices) {
      id(name);
      passive(vertex);
      if (vertex.type === "image" || vertex.type === "imageSquare" || vertex.type === "icon")
        fail();
    }
    let members = 0;
    for (const group of groups) {
      record(group);
      const name = id(group.id);
      const children = array(group.nodes);
      members += children.length;
      if (members > LIMIT || parents.has(name)) fail();
      parents.set(name, undefined);
    }
    const groupNames = new Set(parents.keys());
    for (const group of groups)
      for (const child of group.nodes) {
        id(child);
        if (!vertices.has(child) && !groupNames.has(child)) fail();
        if (groupNames.has(child)) {
          if (parents.get(child) != null) fail();
          parents.set(child, group.id);
        }
      }
    forest(parents);
    // Count raw hidden/collapsed content as work, not only visible layout IR.
    bounded(vertices.size + groups.length, edges.length + members);
    return layout(db);
  };
  const usecase = (db) => {
    const actors = map(db.getActors());
    const uses = map(db.getUseCases());
    const boundaries = map(db.getSystemBoundaries());
    const notes = map(db.getNotes());
    if (map(db.getJsonNodes()).size) fail(); // Unqualified native table flattening.
    const relations = array(db.getRelationships());
    for (const [name, actor] of actors) {
      id(name);
      record(actor);
      if (actor.icon != null || actor.type === "icon" || actor.type === "awesome") fail();
    }
    let relationRanks = 0;
    for (const relation of relations) {
      record(relation);
      integer(relation.minlen, 0);
      relationRanks += Math.max(1, relation.minlen);
      if (relationRanks > LIMIT) fail();
      if (relation.animate || relation.animation != null) fail();
    }
    bounded(actors.size + uses.size + boundaries.size + notes.size, relations.length + notes.size);
    return layout(db);
  };
  const eventmodeling = (db, source) => {
    // getState is an allocating/DOM-measuring resolver, not a passive getter.
    // Native hidden whitespace permits several frames on one line, and reset
    // frames use rf/resetframe rather than tf. A line-anchored regex would miss
    // both. This bounded lexer is only conservative admission, never a parser
    // substitute or source rewrite: the exact native parser has already run.
    // Skip native comments and inline payload terminals, preserving every
    // bare frame/arrow token before the allocating native state resolver.
    // Multiline data/accessibility blocks remain source-only until their
    // distinct greedy terminal and output-label contracts are qualified.
    const tokens = [];
    for (let offset = 0; offset < source.length;) {
      const rest = source.slice(offset);
      if (/^\s/.test(rest)) {
        offset++;
      } else if (rest.startsWith("/*")) {
        const end = source.indexOf("*/", offset + 2);
        if (end < 0) fail();
        offset = end + 2;
      } else if (rest.startsWith("%%") || rest.startsWith("//")) {
        const end = source.indexOf("\n", offset + 2);
        offset = end < 0 ? source.length : end + 1;
      } else if (rest[0] === "{" || rest[0] === '"' || rest[0] === "'") {
        // The pinned native label builder assumes braces even for quoted
        // inline terminals, then removes the character immediately before }.
        // Preserve only brace payloads whose removed character is whitespace;
        // never qualify silently truncated authored data or alternate HTML.
        if (rest[0] !== "{") fail();
        const end = source.indexOf("\n", offset + 1);
        const lineEnd = end < 0 ? source.length : end;
        const payloadEnd = source.lastIndexOf("}", lineEnd - 1);
        if (payloadEnd <= offset) fail();
        const payload = source.slice(offset + 1, payloadEnd);
        if (!/\s$/.test(payload) || /[<>]/.test(payload)) fail();
        offset = payloadEnd + 1;
      } else if (rest.startsWith("->>")) {
        tokens.push("->>");
        offset += 3;
      } else {
        const token = /^(?:[_a-zA-Z]\w*|\d+|\.)/.exec(rest)?.[0];
        if (token) {
          tokens.push(token);
          offset += token.length;
        } else offset++;
      }
      if (tokens.length > 4096) fail();
    }
    const kinds = new Set(["tf", "timeframe", "rf", "resetframe"]);
    const models = new Set([
      "ui",
      "pcr",
      "processor",
      "rmo",
      "readmodel",
      "cmd",
      "command",
      "evt",
      "event",
    ]);
    const declarations = [];
    const frameNames = new Set();
    let dependencies = 0;
    let explicitForFrame = 0;
    for (let index = 0; index < tokens.length; index++) {
      // The pinned parser accepts these declarations but its native state and
      // renderer never consume noteEntities/gwtEntities. Preserve exact source
      // rather than silently presenting an incomplete event-modeling picture.
      if (["note", "gwt"].includes(tokens[index])) fail();
      if (kinds.has(tokens[index])) {
        // Every declaration keyword must qualify before the allocating getter,
        // even alongside an otherwise valid frame. Never leave an unknown or
        // out-of-contract native frame uncounted until the post-resolution cap.
        if (!/^\d{1,3}$/.test(tokens[index + 1] ?? "")) fail();
        if (declarations.length && !explicitForFrame) dependencies++;
        explicitForFrame = 0;
        const name = tokens[index + 1];
        if (frameNames.has(name) || !models.has(tokens[index + 2])) fail();
        frameNames.add(name);
        declarations.push(name);
        if (declarations.length > LIMIT) fail();
        index += 3;
        if (!/^[_a-zA-Z]\w*$/.test(tokens[index] ?? "")) fail();
        if (reserved.has(tokens[index])) fail();
        while (tokens[index + 1] === ".") {
          index += 2;
          if (!/^[_a-zA-Z]\w*$/.test(tokens[index] ?? "") || reserved.has(tokens[index])) fail();
        }
      } else if (tokens[index] === "->>") {
        // Each reference can make native getState filter all frames and append
        // a relation before the post-resolution cap. Bound that work first.
        const name = tokens[++index];
        if (!declarations.length || !/^\d{1,3}$/.test(name ?? "")) fail();
        // The syntax parser accepts unresolved or forward cross-references,
        // but native getState allocates boxes in source order and silently
        // filters/drops sources whose boxes do not yet exist. Require an
        // already-declared source (including the current native frame) before
        // resolving, not merely a name that appears somewhere later in the AST.
        if (!frameNames.has(name)) fail();
        dependencies++;
        explicitForFrame++;
        if (dependencies > LIMIT) fail();
      }
    }
    if (declarations.length && !explicitForFrame) dependencies++;
    if (!declarations.length || dependencies > LIMIT) fail();
    const state = record(db.getState());
    const boxes = array(state.boxes);
    const lanes = record(state.swimlanes);
    const relations = array(state.relations);
    const laneNames = Object.keys(lanes);
    if (laneNames.length > LIMIT) fail();
    if (boxes.length !== declarations.length) fail();
    for (const name of laneNames) {
      if (reserved.has(name)) fail();
      const lane = record(lanes[name]);
      text(lane.label);
      for (const field of ["r", "y", "height", "maxHeight", "index"]) finite(lane[field]);
    }
    const boxSet = new Set(boxes);
    for (const box of boxes) {
      record(box);
      text(box.text);
      for (const field of ["r", "x", "y", "index"]) finite(box[field]);
      const dimensions = record(box.dimension);
      if (finite(dimensions.width) <= 0 || finite(dimensions.height) <= 0) fail();
    }
    for (const relation of relations) {
      record(relation);
      if (!boxSet.has(relation.sourceBox) || !boxSet.has(relation.targetBox)) fail();
      for (const end of [relation.source, relation.target]) {
        record(end);
        finite(end.x);
        finite(end.y);
      }
    }
    return bounded(declarations.length + laneNames.length, relations.length);
  };
  const venn = (db) => {
    const subsets = array(db.getSubsetData());
    const labels = array(db.getTextData());
    const styles = array(db.getStyleData());
    const singles = new Map();
    const keys = new Set();
    let memberships = 0;
    for (const item of subsets) {
      record(item);
      const sets = array(item.sets);
      if (!sets.length || sets.length > 8 || new Set(sets).size !== sets.length) fail();
      for (const name of sets) id(name);
      const key = JSON.stringify([...sets].sort());
      if (keys.has(key)) fail();
      keys.add(key);
      // Native Venn layout derives radii from size / PI and repeatedly divides
      // by those radii. Merely accepting a positive finite subnormal can yield
      // a zero radius and non-finite numerical work before SVG admission. Keep
      // a conservative finite optimization domain, not just a paint-time test.
      if (finite(item.size) < 1e-6 || item.size > 1e6) fail();
      optionalText(item.label);
      if (sets.length === 1) singles.set(sets[0], item.size);
      memberships += sets.length;
      if (memberships > LIMIT) fail();
    }
    // venn.js optimizes overlapping areas, with pairwise subsets synthesized
    // by Mermaid. Eight circles bound that numerical work independently of
    // the authored subset count; never admit hundreds of single circles.
    if (!singles.size || singles.size > 8) fail();
    let predicted = subsets.length;
    const synthesized = new Set(keys);
    for (const item of subsets) {
      for (const name of item.sets) if (!singles.has(name) || item.size > singles.get(name)) fail();
      for (let left = 0; left < item.sets.length; left++)
        for (let right = left + 1; right < item.sets.length; right++) {
          const key = JSON.stringify([item.sets[left], item.sets[right]].sort());
          if (!synthesized.has(key)) {
            synthesized.add(key);
            predicted++;
          }
        }
    }
    for (const item of labels) {
      record(item);
      id(item.id);
      optionalText(item.label);
      for (const name of array(item.sets)) if (!singles.has(id(name))) fail();
    }
    for (const entry of styles) {
      record(entry);
      for (const name of array(entry.targets)) if (!singles.has(id(name))) fail();
      record(entry.styles);
    }
    return bounded(predicted + labels.length + styles.length, memberships);
  };
  const wardley = (db) => {
    const data = record(db.getWardleyData());
    const nodes = array(data.nodes);
    const links = array(data.links);
    const trends = array(data.trends);
    const pipelines = array(data.pipelines);
    const annotations = array(data.annotations);
    const notes = array(data.notes);
    const accelerators = array(data.accelerators);
    const deaccelerators = array(data.deaccelerators);
    const names = new Set();
    const coordinate = (item) => {
      record(item);
      // The pinned parser converts authored normalized [visibility,evolution]
      // pairs into native x/y percentages. Validate that exact database domain;
      // never rescale source text or the database again. Axis stage boundaries
      // are a separate unit-interval contract and remain checked below.
      percent(item.x);
      percent(item.y);
    };
    for (const node of nodes) {
      coordinate(node);
      if (names.has(id(node.id))) fail();
      names.add(node.id);
      text(node.label);
      for (const field of ["labelOffsetX", "labelOffsetY"])
        if (node[field] != null && Math.abs(finite(node[field])) > 10000) fail();
    }
    for (const link of links) {
      record(link);
      if (!names.has(id(link.source)) || !names.has(id(link.target))) fail();
      optionalText(link.label);
    }
    for (const trend of trends) {
      record(trend);
      if (!names.has(id(trend.nodeId))) fail();
      percent(trend.targetX);
      percent(trend.targetY);
    }
    let members = 0;
    for (const pipeline of pipelines) {
      record(pipeline);
      if (!names.has(id(pipeline.nodeId))) fail();
      for (const name of array(pipeline.componentIds)) if (!names.has(id(name))) fail();
      members += pipeline.componentIds.length;
      if (members > LIMIT) fail();
    }
    for (const item of annotations) {
      record(item);
      integer(item.number, 0, 10000);
      optionalText(item.text);
      for (const point of array(item.coordinates)) coordinate(point);
      members += item.coordinates.length;
      if (members > LIMIT) fail();
    }
    for (const note of notes) {
      coordinate(note);
      text(note.text);
    }
    for (const item of [...accelerators, ...deaccelerators]) {
      coordinate(item);
      text(item.name);
    }
    if (data.annotationsBox != null) coordinate(data.annotationsBox);
    const axes = record(data.axes);
    if (axes.stages != null) for (const stage of array(axes.stages)) text(stage);
    if (axes.stageBoundaries != null) {
      let previous = -1;
      for (const boundary of array(axes.stageBoundaries)) {
        unit(boundary);
        if (boundary <= previous) fail();
        previous = boundary;
      }
    }
    if (data.size != null) {
      record(data.size);
      integer(data.size.width, 16, 8192);
      integer(data.size.height, 16, 8192);
    }
    return bounded(
      nodes.length +
        annotations.length +
        notes.length +
        accelerators.length +
        deaccelerators.length +
        (axes.stages?.length ?? 0),
      links.length + trends.length + pipelines.length + members,
    );
  };
  const cynefin = (db) => {
    const domains = map(db.getDomains());
    const transitions = array(db.getTransitions());
    const names = new Set(["complex", "complicated", "clear", "chaotic", "confusion"]);
    let items = 0;
    for (const [name, domain] of domains) {
      record(domain);
      if (!names.has(name) || domain.name !== name) fail();
      for (const item of array(domain.items)) text(record(item).label);
      items += domain.items.length;
      if (items > LIMIT) fail();
    }
    for (const transition of transitions) {
      record(transition);
      if (!names.has(transition.from) || !names.has(transition.to)) fail();
      optionalText(transition.label);
    }
    // The renderer always includes five domain regions, even if no text was
    // authored in one of them. Count that fixed geometry, not only the Map.
    return bounded(5 + items, transitions.length);
  };
  const railroad = (db) => {
    const rules = array(db.getRules());
    if (!rules.length) fail();
    const names = new Set();
    const seen = new Set();
    const pending = [];
    let nodes = rules.length;
    let edges = 0;
    for (const rule of rules) {
      record(rule);
      if (names.has(id(rule.name))) fail();
      names.add(rule.name);
      optionalText(rule.comment);
      pending.push([rule.definition, 0]);
    }
    while (pending.length) {
      const [node, depth] = pending.pop();
      record(node);
      if (seen.has(node) || depth > 64 || ++nodes > LIMIT) fail();
      seen.add(node);
      let children = [];
      switch (node.type) {
        case "terminal":
          text(node.value);
          break;
        case "nonterminal":
          text(node.name);
          break;
        case "special":
          text(node.text);
          break;
        case "sequence":
          children = array(node.elements);
          if (!children.length) fail();
          break;
        case "choice":
          children = array(node.alternatives);
          if (!children.length) fail();
          break;
        case "optional":
          children = [node.element];
          break;
        case "repetition":
          // The pinned renderer only draws star/plus based on min, and drops
          // max/separator. Finite repeats or separators must remain source,
          // rather than display a diagram with different grammar semantics.
          if ((node.min !== 0 && node.min !== 1) || node.max !== Infinity || node.separator != null)
            fail();
          children = [node.element];
          break;
        default:
          fail();
      }
      edges += children.length;
      if (edges > LIMIT) fail();
      for (const child of children) pending.push([child, depth + 1]);
    }
    return bounded(nodes, edges);
  };
  globalThis.cafeMermaidExtendedFamilySize = (type, db, source) => {
    switch (type) {
      case "mindmap":
        return mindmap(db);
      case "architecture":
        return architecture(db);
      case "c4":
        return c4(db);
      case "swimlane":
        return layout(db);
      case "agentflow":
        return agentflow(db);
      case "usecase":
        return usecase(db);
      case "eventmodeling":
        return eventmodeling(db, source);
      case "venn":
        return venn(db);
      case "ishikawa":
        return tree(db.getRoot(), (node) => text(node.text));
      case "wardley":
        return wardley(db);
      case "cynefin":
        return cynefin(db);
      case "treeView":
        return treeView(db);
      case "info":
        // This native diagram renders only its pinned version label. It is
        // deliberately qualified as a one-item image, not an arbitrary DB.
        if (db.getVersion() !== "12.0.0") fail();
        return [1, 0];
      case "railroad":
      case "railroadEbnf":
      case "railroadAbnf":
      case "railroadPeg":
        return railroad(db);
      default:
        return undefined;
    }
  };
})();
