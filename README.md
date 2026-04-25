# Stress Conditioned Inventory Risk Dashboard

**Live demo:** https://stress-conditioned-inventory-risk-dashboard-8p6jb8f8l.vercel.app/  
**Author:** Neil Sharma 

## Executive Summary

This project is a live inventory risk dashboard for the Savannah to Atlanta replenishment lane. It ingests real disruption signals, converts them into a current stress score, and maps that score into model based stockout risk estimates and inventory policy recommendations.

The goal is simple: when operating conditions change, inventory policy should change with them.

The dashboard does not track live grocery stockouts or store inventory. It uses live disruption signals, including National Weather Service alerts and optional Georgia 511 traffic events, to estimate how much inventory coverage is needed under the current stress regime.

## What It Does

The dashboard answers one main question: given current disruption conditions, how many days of cover are needed to keep stockout risk under a target level?

Users can adjust days of cover, target stockout probability, policy scenario, holding cost, and shortage cost. The system returns the current stress regime, stress score, stockout probability, expected shortage, recommended days of cover, minimum feasible policy, coverage margin, policy cost index, live source summary, and operational takeaway.

## Live Signal Model

Every refresh, the frontend calls `/api/latest` with the selected days of cover and scenario. The backend checks current data sources, computes a stress score, classifies the operating regime, and returns an updated risk estimate.

A low stress score does not mean the system is not live. It means the current disruption signals are quiet.

Current inputs include:

| Source | Status | Role |
|---|---|---|
| National Weather Service alerts | Live | Weather disruption signal |
| Georgia 511 traffic events | Optional | Road disruption signal |
| Port baseline score | Manual | Slower baseline stress input |

## Policy Scenarios

The dashboard compares three policy scenarios:

| Scenario | Description |
|---|---|
| Baseline | Standard replenishment with no added mitigation |
| Safety Stock | Adds inventory protection by increasing the effective coverage position |
| Tail Mitigation | Reduces rare severe delay outcomes that can dominate residual stockout risk |

The purpose is to compare operational responses, not just estimate risk.

