---
name: tailor
description: Generate an evidence-led tailored CV and outreach draft for one tracked Scout opportunity.
---

# Tailor an application

1. Read the master CV, profile, workspace settings, and tracker entry. Stop for material gaps rather than inventing facts.
2. Verify the current advert and public company context.
3. Write `applications/<company-slug>/cv.typ` using `/cv/template.typ`; reorder only supported evidence around the target's needs and mark unresolved gaps as Typst comments.
4. Render with Typst and verify the PDF exists and is approximately two pages unless the profile says otherwise.
5. Draft `outreach.md` in the user's locale and tone. Include relevant questions from their priorities.
6. Add only publicly listed contacts, set the appropriate draft/outreach state, and add a dated note. Do not record an outreach-sent event until the user confirms sending.
7. Summarise the angle, gaps, and review points. Never send anything.
