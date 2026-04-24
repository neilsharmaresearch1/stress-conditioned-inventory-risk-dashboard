# Stress Conditioned Inventory Risk Dashboard

**Live demo:** https://stress-conditioned-inventory-risk-dashboard-m3n0wdd0m.vercel.app/  

**Author:** Neil Sharma

A live, API backed risk intelligence dashboard for inventory policy on the Savannah to Atlanta replenishment lane.

The system ingests real disruption signals, converts them into a composite stress score, classifies the current operating regime, and returns model based stockout risk estimates with scenario specific inventory policy recommendations.

This project is built around one operations research question:

**How should inventory policy change when system stress changes?**

---

## Project Summary

This dashboard is a live decision support system for inventory risk under uncertainty.

It does not directly observe store inventory or real time stockouts. Instead, it uses live external disruption signals as inputs to a stress conditioned inventory risk model.

The purpose is to make the full decision chain visible:

```text
Live disruption signals
        ↓
Weather, traffic, and port stress inputs
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
