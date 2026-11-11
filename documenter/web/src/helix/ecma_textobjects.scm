; Helix 25.07.1 runtime/queries/ecma/textobjects.scm, used under the MPL-2.0.
; https://github.com/helix-editor/helix/blob/25.07.1/runtime/queries/ecma/textobjects.scm
; Changed: `function` is `function_expression` in the grammars documenter uses,
; which are newer than Helix's.

(function_declaration
  body: (_) @function.inside) @function.around

(function_expression
  body: (_) @function.inside) @function.around

(arrow_function
  body: (_) @function.inside) @function.around

(method_definition
  body: (_) @function.inside) @function.around

(generator_function_declaration
  body: (_) @function.inside) @function.around

(class_declaration
  body: (class_body) @class.inside) @class.around

(class
  (class_body) @class.inside) @class.around

(export_statement
  declaration: [
    (function_declaration) @function.around
    (class_declaration) @class.around 
  ])

(formal_parameters
  ((_) @parameter.inside . ","? @parameter.around) @parameter.around)

(arguments
  ((_) @parameter.inside . ","? @parameter.around) @parameter.around)

(comment) @comment.inside

(comment)+ @comment.around

(array 
  (_) @entry.around)

(pair
  (_) @entry.inside) @entry.around

(pair_pattern
  (_) @entry.inside) @entry.around
