# sankey-plus

***NOT READY FOR USE YET - CONTAINS BUGS :)***

A JavaScript library for computing and drawing Sankey graphs.

Based on the [D3-Sankey](https://github.com/d3/d3-sankey) and D3-Sankey-Circular(https://github.com/tomshanley/d3-sankey-circular) libraries, and the experiments in my [Observable notebook](https://observablehq.com/@tomshanley/sankey-circular-deconstructed-part-2-manual-scaling/2).  

This library enhances those to provide:

* Handling for circular links
* Routing of long links to avoid overlapping nodes
* Improved layout
* New API that uses a config object


## API Reference

Import *SankeyChart* from *sankeyPlus.js*:

```JavaScript
import { SankeyChart } from './sankeyPlus.js'
```

Create a new chart:

```JavaScript
let chart = new SankeyChart(element, config);
```

* **element**: An HTML element, such as a DIV, which will contain the SVG element created by SankeyChart.draw()
* **config**: an options object containing the configuration for the sankey chart.

To render the chart, call the *draw()* method, which creates an SVG element in the specified HTML element:

```JavaScript
chart.draw();
```

## Config options:

The config options has the structure:

```JavaScript
let config = {
    //main options
    nodes: {
        //data and options for nodes
    },
    links: {
        //data and options for links
    },
    arrows: {
        //data and options for links
    }
}
```
### Main
| Option      | Description | Default       | Mandatory       |
| ----------- | ----------- |  ----------- | ----------- | 
| justify      | Title       | Left       |  No     |
| id   | If id is specified, sets the node id accessor to the specified function        | d => d.name      |   No    |
| iterations   | The number of relaxation iterations        | 32        | No        |
| padding   | Padding around the chart, in pixels        | 20        | No        |
| width   | Width of the chart   | 1000        | No        |
| height   | Height of the chart        | 500        | No        |
| useManualScale   | TBC  True/False       | True        | No      |

### Nodes
| Option      | Description | Default       | Mandatory       |
| ----------- | ----------- |  ----------- | ----------- | 
| data      | An array of nodes objects, which must contain a property for the ID that is specified in the **id** option (the default is **name**).      | NA      |  Yes       |
| width   | Width of the node, in pixels        | 25        | No        |
| maxHeight   | If useManualScale is enabled, then the maximum height of the node for the scale's range        | 75        | No        |
| padding   | The ideal vertical space between each node          | 25        | No        |
| minPadding   | The minimum vertical space allowed between each node        | 25        | No        |
| virtualPadding   | The vertical space between nodes and any virtual links which are routed around nodes        | 7        | No        |
| horizontalSort   | Boolean. If set to true, the node objects must contain a property `horizontalSort` (Number). The values of this property will be used for the horizontal position. This applies Sankey charts with circular links where the 'first' node(s) is arbitrary. If null or false, the sort order of the nodes are based on in incoming/outgoing links.        | null        | No        |
| verticalSort   | Boolean. If set to true, the node objects must contain a property `verticalSort` (Number). The values of this property will be used for the vertical position, for nodes within the same column. If null or false, the sort order of the nodes is optimized for the best layout.        | null        | No        |
| setPositions   | If true, then the nodes' positions aren't optimised vertical.        | false        | No        |

### Links
| Option      | Description | Default       | Mandatory       |
| ---------- | ----------- |  ----------- | ----------- | 
| data      | An array of links objects, which must contain a **source**, **target** and **value** property. The source and target must refer to a node's ID.      | NA       |  Yes       |
| circularGap   | Text        | 5        | No         
| circularLinkPortionTopBottom   | The portion of the Height  that should be reserved for drawing circular links      | 0.4          | No        |
| circularLinkPortionLeftRight   | The portion of the Width that should be reserved for drawing circular links        |  0.1         | No        |
| useVirtualRoutes   | Text        | Text        | No        |
| virtualPadding   | Text        | Text        | No        |
| baseRadius   | Text        | Text        | No        |
| verticalMargin   | Text        | Text        | No        |
| opacity   | Opacity of the link stroke, from 0 to 1        | 1        | No        |
| virtualLinkType   | Text        | Text        | No        |

### Arrows
| Option      | Description | Default       | Mandatory       |
| ----------- | ----------- |  ----------- | ----------- | 
| enabled      | Select whether to show arrows. True/False       | false       |  No       |
| color   | Color of the arrow. Can use Hex code or CSS color name       | DarkSlateGrey        | No        |
| length   | Length of the arrow, in pixels        | 10        | No        |
| gap   | Length of the gap between each arrow, in pixels        | 25        | No        |
| headSize   | width of the arrow head, in pixels        | 4        | No        |
### Adaptive column spacing

Set `nodes.adaptiveColumnSpacing: true` to give more horizontal room to crowded
backlink turns. The layout uses both the number and stroke widths of backlinks
entering or leaving each gap, redistributing space within the configured chart
width. Long horizontal shelves do not add demand to intermediate gaps. The
option defaults to `false`; layouts without backlinks retain equal spacing.

`nodes.adaptiveColumnSpacingStrength` controls how much backlink load changes
column gaps (default `1`). A value between `0` and `1` balances busy and quiet
gaps more evenly; `0` gives equal spacing. This option applies only when
adaptive column spacing is enabled.

```js
new SankeyChart({
  width: 2600,
  nodes: { data: nodes, adaptiveColumnSpacing: true },
  links: { data: links }
});
```


`nodes.circularSourceOrdering` (default `false`) repairs conflicting circular
source departures. With one upward-return source in a column, it places that
node before downward-return sources and compacts their source turns. This can
change the specified vertical node order. If several nodes return in both
directions, their vertical order is preserved. Independent destination bundles
can inset the lower source node horizontally, retaining its right-side exit
with round local corners. The preceding return lanes and upper departures bound
the inset; only missing corridor room is added before that column. Shared
bottom destination bundles remain aligned. In mixed columns with shared lower
returns, upward departures stay to the right of the preceding source nodes.
The source order follows destination nesting; earlier downward departures take
short rounded turns below their nodes into the preceding corridor. The target
port order follows those source corridors, keeping lower bundles nested.

With this repair enabled, links between separate nodes in one column retain
right-side source and left-side target ports. When space permits, a downward
connection crosses the gap above its target, clearing the source's local loops;
otherwise it retains its full outer loop. Opposite departures keep their lane
gaps as the whole bundle moves outside the short bridge. Only missing corridor
width is added before following columns, with endpoint geometry and enclosing
source frames moving together.

With `nodes.circularSourceOrdering` enabled, inter-column return departures use
`baseRadius + link.width / 2` as the minimum local round radius. The vertical
lane position is allocated separately for clearance. Contiguous parallel lanes
use nested outer radii so their shelf bends share a center; departure bends
also account for the source-port gap. Radius growth is bounded by the available
horizontal and vertical straight segments. Any remaining horizontal offset
uses a straight stub, so lane offsets alone do not inflate a corner radius.
This also applies to mirrored return departures. Same-column loops retain their
own geometry, and anchor adjacent enclosing source bends.

After port reordering, upward return bundles release unoccupied target turn
slots. Target radii and shelves compact together against final node bounds,
foreign lanes and endpoint corners, retaining port order and stroke clearance.

Mirrored upward returns release shelf space reserved by the former right-side
turns. Their final shelf ceiling respects node bounds, endpoint corners and
the existing order of neighboring corridors. Returns sharing a target move as
one bundle, preserving the common center of their nested arrival bends.

An independent outer target return can follow an enclosed round bundle across different
columns. Its shelf uses separate horizontal and vertical radii to share the
inner bend center without changing the arrival corner, allocated lanes or
shelf positions. Radius growth requires clearance on both axes and enough
room for the remaining straight segments; already elliptical inner corners
are not used as nesting anchors. Shared-target bundles and already concentric
adjacent corners in one target column retain their bend centers. Adapting a
corner around another column must not resize just one member of that frame.
Left-leg compaction checks the full span of a long enclosing return,
so pulling it toward its own node cannot pass an intervening target lane and
reverse the nesting order. Ellipse axes are limited to a 2:1 ratio. More stretched corners, or
ones whose minimum curvature would pinch the inside of the stroke, fall back
to round bends; column offsets remain straight shelf segments.

When independent sources are horizontally inset, source lanes are repacked from
their final node positions. A departure starts with the node buffer and local
corner radius; additional offset is reserved only for neighboring lanes, local
loops, or an enclosing rerouted return. Legacy column turn-slot offsets do not
keep these departures artificially far from their nodes.
