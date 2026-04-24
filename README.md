# Stress Conditioned Inventory Risk Dashboard

**Author:** Neil Sharma

A decision support dashboard for inventory policy under operational stress on the Savannah to Atlanta replenishment lane. The tool shows how stress regime, policy scenario, and days of cover change stockout risk, expected shortage, and recommended coverage decisions.

This project is built around a practical operations research question:

**How should inventory policy change when system stress changes?**

## Overview

The dashboard translates an inventory risk model into an interactive decision interface. A user can change stress regime, scenario, service target, and days of cover, then immediately see how those choices affect policy feasibility and operating risk.

The design focus is not generic analytics. It is operational decision making under uncertainty. The goal is to make stockout risk interpretable enough to support an actual policy choice.

## What the Dashboard Does

The interface allows a user to adjust:

* **Stress regime**: Low, Normal, High, Extreme
* **Policy scenario**: Baseline, Safety Stock, Tail Mitigation
* **Current days of cover**
* **Target stockout threshold**
* **Cost frame**: holding cost and shortage penalty

From those inputs, the dashboard computes and displays:

* selected policy pass or fail status
* recommended minimum days of cover
* lowest cost feasible policy
* stockout probability
* expected shortage
* coverage margin relative to the minimum feasible policy
* policy comparison chart across days of cover

## Core Decision Logic

The dashboard is organized around three layers.

### 1. Data Layer

For each combination of stress regime and scenario, the app stores policy curves across days of cover. These curves provide the stockout risk and expected shortage values the interface uses for decision support.

### 2. Decision Layer

Using the active regime, scenario, and service target, the app computes:

* whether the selected policy meets the service constraint
* the minimum feasible days of cover
* the lowest cost feasible policy
* coverage margin above the minimum feasible level
* narrative interpretation of the current decision

### 3. Interface Layer

The outputs are rendered as:

* recommendation cards
* KPI panels
* chart annotations
* policy comparison views
* a decision summary with an operational takeaway

This structure keeps the policy logic separate from presentation, which makes the tool easy to extend and easy to interpret.

## Why the Scenario Structure Matters

The dashboard includes three scenario types because the point of the project is not just to estimate risk, but to compare policy responses.

* **Baseline**  
  No structural mitigation is applied.

* **Safety Stock**  
  Designed to reduce risk most strongly at lower coverage levels by shifting the effective reorder position.

* **Tail Mitigation**  
  Designed to reduce rare extreme delay events, which matters most when residual tail risk dominates at higher coverage levels.

Together, these scenarios let the user compare different ways of managing uncertainty rather than treating inventory as a fixed rule.

## Why This Project Matters

Inventory policy is often set as if operating conditions are stable. In practice, service risk changes when a system moves from normal conditions into high stress or extreme stress. A policy that works under one regime can become weak under another.

This dashboard makes that shift visible. Instead of treating days of cover as static, it treats coverage as a decision that should respond to changing operational stress.

That is the central idea behind the project:

**uncertainty should change the policy, not just the forecast.**

## Technical Stack

* **Runtime:** HTML, CSS, JavaScript
* **Charting:** Chart.js via CDN
* **Fonts:** General Sans and Geist Mono via CDN
* **Build step:** None
* **Backend:** None
* **Deployment target:** Static hosting

The current implementation is intentionally lightweight and fully client side. The entire app runs from a single `index.html` file for fast loading, simple deployment, and easy inspection.

## Repository Contents

* `index.html`  
  Main application file containing layout, styling, policy data, decision logic, and chart rendering

* `vercel.json`  
  Minimal static hosting configuration

* `.gitignore`  
  Excludes development screenshots and notes


