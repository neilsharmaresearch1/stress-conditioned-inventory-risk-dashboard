# Stress Conditioned Inventory Risk Dashboard

**Live demo:** https://stress-conditioned-inventory-risk-dashboard-8p6jb8f8l.vercel.app/)

**Author:** Neil Sharma

A live, API backed decision support dashboard for inventory policy under operational stress on the Savannah to Atlanta replenishment lane.

The dashboard ingests live disruption signals, maps them into a stress score, classifies the current operating regime, and returns model based stockout risk estimates across baseline, safety stock, and tail mitigation scenarios.

This project is built around one practical operations research question:

**How should inventory policy change when system stress changes?**

---

## Overview

This dashboard turns a stress conditioned inventory risk model into an interactive operations decision tool. A user can change policy scenario, service target, and days of cover, then see how those choices affect stockout risk, expected shortage, coverage margin, and recommended inventory policy.

The purpose is not generic analytics. The purpose is decision making under uncertainty.

The system is designed to show how external disruption signals can change the inventory policy required to maintain a target service level.

---

## Core Framing

This project should be understood as:

**Live disruption signal ingestion mapped into model based stockout risk estimates.**

It does **not** directly observe real time grocery stockouts. It does **not** track live retailer inventory. Instead, it uses live operational disruption signals as stress inputs, then maps those stress conditions into a pre calibrated inventory risk model.

The decision chain is:

```text
Live disruption signals
        ↓
Composite stress score
        ↓
Stress regime
        ↓
Scenario specific stockout risk curve
        ↓
Recommended days of cover
        ↓
Operational takeaway

