# AquaFeed Pro — Approved App Design

Approved: October 1, 2026

Product revision: October 2, 2026 — two sequential nozzles with independent doses and schedules. This is an approved requirement; the app and protocol do not yet implement it.

Visual revision: October 12, 2026 — Mono Ink replaces Graphite Bento. Behaviour sections 3–9 are unchanged.

## 1. Purpose and scope

AquaFeed Pro is a phone-first application for monitoring dissolved oxygen (DO), monitoring remaining feed, managing multiple feeding schedules, issuing confirmed manual feeding commands, reviewing feeding history, and pairing or removing feeder devices.

The approved visual direction is **Mono Ink**: ink on paper, one near-black and four greys, hierarchy from type and spacing, one black block per screen for its main action. The pixel reference is docs/design/mono-ink/.

The four main destinations are **Home**, **Schedule**, **History**, and **Device**. Authentication is device-based pairing; no user account or registration screen is included.

This document specifies the approved design, not an assertion that the firmware or app already supports every capability. Example readings, quantities, times, and device names are illustrative. Do not ship placeholder telemetry as real data.

### Implementation priorities

1. Make the selected device unambiguous.
2. Make water condition, remaining feed, and next feeding immediately readable.
3. Require explicit confirmation before manual feeding.
4. Distinguish requested actions from device-confirmed outcomes.
5. Support multiple independently paired devices.
6. Adapt controls to verified device capabilities.

## 2. Visual system

### Colors

| Token | Value | Purpose |
| --- | --- | --- |
| `background` | `#FAFAFA` | Page background |
| `surface` | `#FFFFFF` | Cards, sheets, inputs, navigation |
| `surface-muted` | `#F4F4F5` | Segmented track, icon wells, pills, info notices |
| `ink` | `#18181B` | Headings, readings, primary button, the black block |
| `primary` | `#18181B` | Primary buttons and selected navigation |
| `text` | `#18181B` | Default text |
| `text-secondary` | `#52525B` | Supporting copy, units, all small text on muted surfaces |
| `text-tertiary` | `#71717A` | Metadata, overlines, axis labels; never on muted surfaces |
| `border` | `#E4E4E7` | Card borders and separators |
| `control-border` | `#8A8A93` | Input boundaries, outline buttons, unchecked controls |
| `on-ink` | `#FAFAFA` | Titles, labels and icons on the black block |
| `on-ink-secondary` | `#A1A1AA` | Supporting copy on the black block |
| `progress-track` | `#E4E4E7` | Unfilled progress bars |
| `chart-line` | `#18181B` | DO readings |
| `chart-grid` | `#E4E4E7` | Graph grid |
| `disabled-background` | `#E4E4E7` | Disabled buttons |
| `disabled-text` | `#71717A` | Disabled labels |
| `inverse-disabled-background` | `#52525B` | Disabled button on the black block |
| `scrim` | `rgba(24, 24, 27, 0.4)` | Behind sheets |

Primary buttons use `primary` backgrounds and `on-ink` labels. Secondary buttons use white backgrounds, dark labels, and visible borders. Text actions use dark text. Inverse buttons sit on the black block: white background, dark label.

Warnings, failures, and connection states remain monochrome. Every status uses a readable label and an appropriate icon. Never communicate status only through a dot or a shade of gray.

Examples: check-circle + Completed; clock + Pending; alert-triangle + Low feed; circle-x + Failed; wifi-off + Offline.

Avoid gradients, glass effects, colour hues, and shadows. Use cards for meaningful groups rather than placing every label in a separate box; hierarchy comes from type and spacing.

### Typography

Use **Inter** throughout. Bundle the font with the app so typography does not depend on an internet request. For web implementations, use:

```css
font-family: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
```

| Token | Size / line height | Weight | Other | Color |
| --- | --- | --- | --- | --- |
| `display` | 56 / 60 px | 600 | letter spacing −1, tabular numerals | `ink` |
| `pageTitle` | 28 / 34 px | 600 | — | `ink` |
| `reading` | 32 / 40 px | 600 | tabular numerals | `ink` |
| `title` | 20 / 28 px | 600 | tabular numerals | `ink` |
| `cardTitle` | 16 / 24 px | 600 | — | `ink` |
| `listTitle` | 16 / 24 px | 500 | — | `ink` |
| `body` | 16 / 24 px | 400 | — | `ink` |
| `unit` | 16 / 24 px | 500 | — | `text-secondary` |
| `button` | 15 / 20 px | 600 | — | set by the button |
| `label` | 14 / 20 px | 500 | — | `ink` |
| `supporting` | 14 / 20 px | 400 | — | `text-secondary` |
| `metadata` | 12 / 16 px | 500 | tabular numerals | `text-tertiary` |
| `overline` | 12 / 16 px | 600 | uppercase, letter spacing +0.8 | `text-tertiary` |
| `pill` | 12 / 16 px | 600 | — | `ink` |

`display` is for the DO reading only; `reading` is for tile numbers; `title` is for schedule times and sheet titles; `label` is for persistent input labels.

Use tabular numerals for readings, percentages, times, and quantities. Units are smaller than readings but remain clearly visible. Example: a large `5.8` followed by `mg/L`.

Sizes are logical layout units: use CSS pixels on web or corresponding platform units in native implementations, while respecting text scaling.

### Icons

Use Lucide-style outlined icons with consistent stroke width. Use an existing suitable icon library if available. Navigation icons are 24px; card and button icons are 20px; icons inside status pills and field errors are 16px.

| Purpose | Icon |
| --- | --- |
| Home | `House` |
| Schedule | `CalendarClock` |
| History | `History` |
| Device | `Cpu` |
| Dissolved oxygen | `Waves` |
| Feed remaining | `Container` |
| Manual feeding | `Utensils` |
| Add | `Plus` |
| QR pairing | `QrCode` |
| Connected | `Wifi` |
| Offline | `WifiOff` |
| Warning | `TriangleAlert` |
| More actions | `Ellipsis` |

Pair unfamiliar icons with visible text. Icon-only controls require accessible names.

### Geometry and spacing

| Element | Specification |
| --- | --- |
| Spacing scale | 4, 8, 12, 16, 24, 32px |
| Phone page padding | 20px |
| Card gap | 12px |
| Card padding | 16px |
| Card radius | 16px |
| Button and input radius | 12px |
| Pill radius | 999px |
| Bottom-sheet top radius | 24px |
| Standard button height | 48px |
| Compact button height | 40px |
| Minimum interactive target | 48 × 48px |
| Input height | At least 48px |
| Card border | 1px solid `border` |

Cards grow with their content. Do not use fixed card heights that clip enlarged text. Inputs need persistent labels rather than placeholder-only labels.

## 3. App shell and navigation

### Phone navigation

Use a persistent bottom navigation bar in this order:

```text
Home          Schedule          History          Device
```

Each item has an icon and label. The selected destination uses dark text and a pale rounded background behind its icon. Inactive destinations use secondary text. The bar has a white background, a subtle top border, and bottom safe-area padding. Scrollable content must not be obscured by it.

### Shared header and device context

Home, Schedule, and History begin with the page title, an optional page action, and the selected-device control:

```text
Page title                              Optional action
[ Pond 01 · Feeder A                                  ⌄ ]
```

The device selector opens a sheet listing name, optional location, short identifier, connection state, and a check mark for the current selection. Include a Manage devices link.

Switching device changes all readings, schedules, and history on the current page. Keep the selection consistent across these three destinations. Never render one device's cached values beneath another device's name, and never let an outstanding request update the newly selected device's view with the previous device's results.

The Device page lists all paired devices and has no selected-device dropdown.

### Responsive layout

| Width | Layout |
| --- | --- |
| Below 600px | Phone layout with bottom navigation |
| 600–1023px | Centered content, maximum width 760px; bottom navigation retained |
| 1024px and above | 224px left navigation sidebar; main content maximum width 1120px |

On desktop, use 24–32px main-content padding. Bottom sheets become centered dialogs. Side-by-side cards stack when width or enlarged text makes them cramped. Keep every action and all information available on small screens.

## 4. Home

### Purpose and order

Home answers: How is the water? How much feed remains? When is the next feeding? It also provides a deliberate manual feeding action.

Content order:

1. Title and device selector.
2. Connection status and freshness.
3. Relevant warning banner, when needed.
4. Large DO card.
5. Feed remaining and next feeding cards side by side.
6. Full-width manual feeding card.
7. Recent activity.

### Phone wireframe

```text
Home
[ Pond 01 · Feeder A                              ⌄ ]
Wifi  Online · Updated 3 seconds ago

┌──────────────────────────────────────────────────┐
│ Waves  Dissolved oxygen                           │
│                                                  │
│ 5.8 mg/L                       Within limits      │
│                                                  │
│                  DO line graph                   │
│                                                  │
│                [1H] [6H] [24H]                    │
└──────────────────────────────────────────────────┘

┌───────────────────────┐ ┌────────────────────────┐
│ Feed remaining        │ │ Next feeding           │
│ 72%                   │ │ 6:00 PM                │
│ ███████░░░            │ │ Today · 50 g           │
└───────────────────────┘ └────────────────────────┘

┌──────────────────────────────────────────────────┐
│ Manual feeding                                   │
│ Start a feeding on Feeder A.                      │
│                 [ Feed now ]                     │
└──────────────────────────────────────────────────┘

Recent activity                            View all
Scheduled feeding completed
Today, 12:00 PM · 50 g requested
```

### DO card

Include the Waves icon, Dissolved oxygen label, latest value, `mg/L` unit, status, graph, and `1H / 6H / 24H` range selector. Use one decimal place when sensor precision supports it.

Graph requirements:

- Plot height approximately 180px on phones and 240px on desktop.
- Dark 2px reading line with subtle horizontal grid lines.
- Time on the horizontal axis; DO values with units on the vertical axis.
- Three to five readable axis labels; avoid crowded labels.
- Tap or drag to inspect a timestamp and reading; provide keyboard-accessible equivalents where applicable.
- Leave gaps where readings are missing.
- Do not smooth the line in ways that invent peaks or obscure actual changes.
- Show configured limits as labeled dashed lines, if available.
- Provide an accessible text summary.

Show Within limits only when appropriate limits are configured and the current reading is fresh. Otherwise use neutral text such as Latest reading or Limits not configured. DO limits must come from configuration suitable for the actual setup; do not invent a universal safe range.

If historical data is unavailable, keep the latest valid reading visible and display a graph empty state. Never fabricate historical points.

### Feed remaining card

Include Container icon, Feed remaining label, large whole-number percentage, and a horizontal progress bar approximately 10px tall. The dark fill sits on `progress-track`.

Show remaining weight and capacity only when available from calibrated device data. Below the configured threshold, display a warning icon and Low feed or Refill needed. If unavailable, show `—` and Reading unavailable; unknown is not zero. Expose the percentage through accessibility semantics.

### Next feeding card

Show the next scheduled time, Today/Tomorrow/date, nozzle and portion if supported. When both nozzles are due together, show both amounts and “Nozzle 1, then Nozzle 2.” The card links to Schedule. With no upcoming event, show No upcoming feeding and an Add a schedule action.

### Manual feeding card and confirmation

Use the heading Manual feeding, the sentence Start a feeding on [device name], and a full-width primary Feed now button. It opens a choice of Nozzle 1, Nozzle 2, or Both, followed by dose entry and explicit confirmation. Choosing a nozzle never actuates hardware. Both uses a separate amount for each nozzle, not a shared amount or an automatic split.

```text
Feed now?

Device
Pond 01 · Feeder A

Nozzles
[ Nozzle 1 ] [ Nozzle 2 ] [ Both selected ]

Nozzle 1 amount     [ 50 ] g
Nozzle 2 amount     [ 30 ] g

Nozzle 1 will feed first, then Nozzle 2.
Only one nozzle dispenses at a time.

[ Cancel ]                       [ Confirm feeding ]
```

The confirmation names the device, selected nozzle(s), each requested amount and execution order prominently. The numbers above are illustrative. Show one dose field for a single nozzle and two for Both. Validate each dose against that nozzle's profile; show a read-only summary for a fixed portion. Do not offer gram-based control without device support.

Disable confirmation until every selected dose is valid. Bind the request to the device, ordered nozzle selection and doses; later selection changes cannot retarget it. Both is one deliberate sequence, nozzle 1 then nozzle 2, with no other feed interleaved. Nozzle 2 alone does not run nozzle 1 first.

Expose progress and outcome for each nozzle, including one waiting within the sequence and one not started after a fault. A successful first nozzle cannot make the whole sequence appear completed. Stop the remaining sequence on a fault, uncertain stop or invalid weighing evidence; preserve completed work and never automatically repeat or resume an uncertain feed. Freeze these semantics in the revised contract and simulator before implementation.

| State | Display and behavior |
| --- | --- |
| Sending request | Sending command…; prevent duplicate submissions |
| Device accepted | Starting feeding… |
| Device reports operation | Feeding in progress… |
| Device confirms completion | Feeding completed |
| Device rejects request | Explain failure and available next action |
| Acknowledgment lost after submission | Status unknown. Check the device before feeding again. |
| Offline before submission | Disable feeding and explain that the device is offline |
| Already feeding | Show ongoing operation and disable another feed |

Do not report completion merely because a request was sent. Do not automatically retry an uncertain feeding command or queue a manual feed to execute after reconnection. Keep meaningful pending/unknown state visible after the sheet closes.

### Recent activity and desktop layout

Show the latest three feeding records, each with a status icon, event label, timestamp, and known portion information. View all opens History for the same device.

Desktop Home uses a 12-column grid: DO spans eight columns; feed remaining and next feeding stack in the remaining four. In the following row, manual feeding spans four columns and recent activity spans eight.

## 5. Schedule

### Layout

Show the title Schedule with an Add action, device selector, enabled-schedule count, and device-time-zone note. Example: Times shown in device time · Asia/Manila. Use the actual selected device's time zone.

Below this, render a vertical list sorted by time of day, then nozzle 1 before nozzle 2 for ties. Each schedule targets exactly one nozzle. Different nozzles may share a time; label their sequential order. Favor readable schedule cards over decorative grid arrangements.

```text
Schedule                                    [+ Add]
[ Pond 01 · Feeder A                              ⌄ ]
3 enabled schedules
Times shown in device time · Asia/Manila

┌──────────────────────────────────────────────────┐
│ 6:00 AM                                [Enabled] │
│ Nozzle 1 · Every day · 50 g                      │
│ Saved to device                              [⋯] │
└──────────────────────────────────────────────────┘
```

Each card includes time as the strongest text, nozzle, repeat days, supported portion, enabled switch, device-save status, and a menu with Edit and Delete. A card may open editing, but switch and menu interactions must remain separate and not trigger the card action.

### Add/edit form

Use a dedicated form screen on phones and a dialog on desktop. Fields appear in this order:

1. Device name, read-only.
2. Nozzle 1 or Nozzle 2.
3. Feeding time using a platform-appropriate time picker.
4. Repeat selection: Every day or Custom days, with Monday–Sunday chips.
5. Feed amount for this nozzle, only if supported; otherwise fixed-portion summary.
6. Enabled switch.
7. Device-time-zone note.
8. Primary save action.

Creation action: Add schedule. Editing action: Save changes.

Validation requires a nozzle, valid time, at least one repeat day, and a supported portion. Prevent duplicate/overlapping due slots for the same nozzle. The same due time on different nozzles is valid: explain “Nozzle 1, then Nozzle 2”; do not skip nozzle 2 merely because nozzle 1 is running its paired occurrence. Apply the real device schedule capacity. Other busy/deadline conflicts follow the revised contract and must not create hidden delayed feeds.

### Save, toggle, delete, and offline behavior

Show Saving to device… while pending, Saved to device only after acknowledgment, and Could not save. Try again. on failure. Preserve form input when saving fails.

A switch may update optimistically, but it must show pending state and return to the previous value if rejected. Avoid showing an unconfirmed change as active on the device.

Delete requires confirmation:

> Delete the 6:00 AM schedule?
> This removes this feeding schedule from Feeder A.

Actions: Cancel and Delete schedule. Do not claim deletion until acknowledged.

When offline, show previously saved schedules with Last synced metadata. Disable changes that cannot be delivered and explain why. Do not silently queue edits or deletions.

### Empty state

> No feeding schedules
> Add a time and repeat days for automatic feeding.

Primary action: Add schedule.

## 6. History

### Layout and defaults

Show History, the shared device selector, date range control, Filter action, two compact summary cards, and a chronological record list.

Default: Last 7 days, all feeding sources, all statuses. Group records by date and sort newest first.

```text
History
[ Pond 01 · Feeder A                              ⌄ ]
[ Last 7 days ⌄ ]                         [ Filter ]

┌───────────────────────┐ ┌────────────────────────┐
│ Completed             │ │ Needs attention        │
│ 18                    │ │ 1                      │
└───────────────────────┘ └────────────────────────┘

Today
Check-circle  Scheduled feeding
              12:00 PM · 50 g requested
              Completed                          >

Yesterday
Circle-x      Scheduled feeding
              6:00 PM
              Failed                             >
```

Summary counts reflect the selected device and active filters. Needs attention includes failed and unknown outcomes; explain that definition in supporting text. Do not present counts from only a loaded page as totals for a larger filtered range.

### Filters

- Date: Today, Last 7 days, Last 30 days, Custom.
- Source: All, Manual, Scheduled.
- Status: All, Completed, Failed, In progress, Unknown.

On phones use a filter sheet with active-filter count and Clear filters. Use the selected device's time zone consistently for displayed event times and date boundaries, with the time zone available in the view.

### Record rows and details

Rows include status icon, manual/scheduled label, nozzle, time, requested portion if known, explicit status, and details chevron. Group a Both sequence while exposing separate nozzle outcomes, requested amounts, measured amounts and measurement quality. The shared container's remaining weight is one device reading, not two independent nozzle inventories. Never label requested weight as actual dispensed weight.

Details open in a sheet or detail screen and show:

- Device name and identifier.
- Manual or scheduled source.
- Requested amount.
- Actual dispensed amount only when measured.
- Request timestamp.
- Start and completion timestamps if reported.
- Final or current status.
- Failure reason or device message when available.

Place technical event IDs in an expandable Technical details section. Do not expose credentials or secrets in device messages.

Do not add a one-tap Feed again action. Manual feeding stays in the Home confirmation flow.

### Empty, loading, error, and desktop states

No records: No feeding history yet. Feeding activity will appear here when available.

No filter matches: No records match these filters. Provide Clear filters.

Loading failure: Couldn’t load history. Provide Retry. Previously loaded records may remain visible with a May be outdated notice.

On desktop, use a table with Time, Source, Requested amount, Status, and Details columns.

## 7. Device

### Device list

Show Device with an Add action and paired-device count. Use one column on phones and two on larger screens.

```text
Device                                      [+ Add]
2 paired devices

┌──────────────────────────────────────────────────┐
│ Cpu  Feeder A                            Selected │
│ Pond 01                                          │
│ ID: …A42F                                        │
│ Wifi  Online · Last seen just now                 │
│                                                  │
│ [ Open dashboard ]                    [ Manage ] │
└──────────────────────────────────────────────────┘
```

Each device card shows friendly name, optional location, short identifier, connection state, last contact, selected indicator, Open dashboard, and Manage. Offline devices remain available for inspecting last known information. Open dashboard selects the card's device and navigates to Home.

### Pairing flow

1. Choose Scan QR code or Enter pairing details.
2. Identify the device; show its discovered name and identifier.
3. Verify access using the credential or physical confirmation supported by the firmware.
4. Set a required friendly name and optional location.
5. Show Device added with Open dashboard.

No user email/password registration is included. Public serial numbers and device identifiers are not authentication secrets. The pairing flow must include real verification, with the exact mechanism determined by firmware support.

Handle camera permission denial with manual entry; invalid QR codes; incorrect pairing codes; unreachable devices; expired pairing sessions; already-paired devices; and access rejection. Provide contextual feedback and a useful next action without discarding correct input unnecessarily.

Do not expose pairing secrets in device cards, History, or routine logs. Store device access credentials using appropriate secure platform storage when functionality is implemented.

### Manage device screen

| Group | Contents |
| --- | --- |
| Identity | Name, location, full identifier |
| Connection | Status and last contact |
| Monitoring | Supported DO limits, low-feed threshold, sensor availability |
| Feeding | Supported portion range or fixed portion |
| Time | Device time zone |
| Access | Pairing/access state |
| Remove | Remove from this app action |

Only offer editable hardware settings that the device supports. Distinguish local names and display preferences from changes to device configuration. Do not imply that a local label change modifies firmware settings.

### Removal and replacement

Removal requires this confirmation:

> Remove Feeder A from this app?
> Its saved access will be removed from this phone. Feeding schedules already stored on the device may continue.

Actions: Cancel and Remove device.

Removal must not silently reset hardware, erase device history, or disable stored schedules. If the selected device is removed, select another paired device and make the new selection clear. If none remain, show the first-device empty state.

Pair replacement hardware as a new device. Do not automatically copy schedules or calibration from the previous device.

## 8. Shared states

| Situation | Required behavior |
| --- | --- |
| No paired device | Home shows Add your first device; Schedule and History explain why they are empty and link to device pairing |
| Initial loading | Skeletons follow actual card geometry |
| Background refresh | Preserve displayed data instead of replacing the entire page with a spinner |
| Device offline | Show Offline and last contact; disable unavailable commands |
| Device online but sensor unavailable | Keep device Online and mark only the sensor unavailable |
| Stale reading | Mark Outdated and show its timestamp |
| No DO history | Keep latest valid value and show graph empty state |
| Already feeding | Show ongoing operation and disable duplicate feeding |
| Partial monitoring failure | Keep other working cards available |
| Save failure | Preserve form data and show an inline error |
| Unsaved form dismissal | Ask whether to discard changes |

Connection status and telemetry freshness are separate facts. Use a configurable freshness threshold based on the actual telemetry interval. Never turn missing or invalid measurements into plausible numeric values.

## 9. Accessibility and motion

- Provide accessible names for controls and meaningful status text.
- Keep keyboard focus clearly visible and preserve logical reading order.
- Support text scaling without clipping readings, hiding actions, or forcing unnecessary horizontal scrolling.
- Dialogs retain focus and return it to their trigger when dismissed.
- Charts provide a readable text summary and accessible inspected values.
- Feed progress exposes its numeric value and label.
- Do not announce every telemetry update through screen readers; announce meaningful status changes appropriately.
- Use restrained 150–200ms transitions and respect reduced-motion settings.
- Do not animate every graph redraw or use decorative motion in live readings.

## 10. Implementation boundaries and unresolved device contracts

Reuse the kit's components: app shell (`AppPage`, `ScreenHeader`, tab bar), device picker, card (`BentoCard` in three tones), `Button`, `IconButton`, `TextField`, `Segmented`, `Chip`, `Toggle` / `SwitchRow`, `StatusLabel`, `Notice`, `ListRow`, `KeyValue`, `SectionHeader`, `Stat`, `ProgressBar`, `Skeleton`, `Sheet`, `EmptyState`, `ErrorState`, and the DO chart. Follow existing project patterns rather than introducing unnecessary abstractions or dependencies.

The design does not choose a frontend framework, backend transport, database, or pairing protocol. Resolve those from the actual project and supported hardware before implementing behavior.

| Fact to verify | Effect on implementation |
| --- | --- |
| Adjustable weight versus fixed portion | Editable amount input versus read-only summary |
| Calibrated remaining weight and capacity | Whether accurate weight and percentage can be displayed |
| DO reporting interval | Freshness threshold and update behavior |
| Available DO history | Supported graph ranges and empty states |
| Schedule capacity and execution location | Limits, conflict validation, and offline explanation |
| Device time and time zone support | Schedule interpretation and history date boundaries |
| Pairing mechanism | QR payload, credential, and physical-confirmation steps |
| Feeding acknowledgment and measurements | Permitted progress states and requested-versus-actual quantities |
| Device configuration capabilities | Which Manage device fields can be edited |

Do not invent universal DO limits, feed thresholds, maximum portions, schedule capacity, or calibration values. Preserve real calibration controls where the hardware requires tuning.

## 11. Design acceptance checklist

- [ ] Inter, the Mono Ink tokens, spacing, icons and radii are consistent, and every screen matches docs/design/mono-ink/.
- [ ] Home, Schedule, History, and Device exist with the specified navigation and content hierarchy.
- [ ] Device switching updates all scoped content without mixed-device information.
- [ ] DO includes units, graph, freshness, missing-data handling, and configured-limit semantics.
- [ ] Feed remaining includes percentage and progress bar, with explicit unknown and low-feed states.
- [ ] Feed now offers Nozzle 1, Nozzle 2 or Both, then confirms the device and separate supported amount per selected nozzle.
- [ ] Both runs nozzle 1 then nozzle 2 without overlap, with separate progress and outcomes.
- [ ] Pending, accepted, operating, completed, failed, and unknown outcomes reflect actual evidence.
- [ ] Offline or uncertain commands are not silently queued or retried.
- [ ] Per-nozzle schedules can be added, edited, toggled and deleted with device-save feedback; simultaneous cross-nozzle schedules run 1 then 2.
- [ ] History filters and counts are consistent, and requested versus measured quantities are distinct.
- [ ] Device pairing verifies access; removing access does not silently alter device operation.
- [ ] Phone, tablet, desktop, enlarged-text, empty, loading, error, and offline layouts remain usable.

The approved scope is this design specification. Implementation and hardware capability verification are separate work.
