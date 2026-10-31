import { RuleTester } from "eslint"
import { rules } from "./plugin"

const ruleTester = new RuleTester()

ruleTester.run(
  "lyrolab/restricted-syntax",
  rules["restricted-syntax"] as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      {
        code: `const name = productName()`,
        options: [{ selector: "Literal[value=/\\bAcme\\b/]" }],
      },
    ],
    invalid: [
      {
        code: `const name = "Acme"`,
        options: [
          {
            selector: "Literal[value=/\\bAcme\\b/]",
            message: "Call productName().",
          },
        ],
        errors: [{ message: "Call productName()." }],
      },
      {
        code: "const model = `openai/gpt-4o`",
        options: [{ selector: "TemplateElement" }],
        errors: [{ message: "Using 'TemplateElement' is not allowed." }],
      },
    ],
  },
)
