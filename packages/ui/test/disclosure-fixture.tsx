import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../src/components/disclosure.tsx";

/** Tabs + accordion used by the component tests. */
export function Disclosure() {
  return (
    <>
      <Tabs defaultValue="design">
        <TabsList aria-label="Inspector">
          <TabsTrigger value="design">Design</TabsTrigger>
          <TabsTrigger value="arrange">Arrange</TabsTrigger>
          <TabsTrigger value="animate">Animate</TabsTrigger>
        </TabsList>
        <TabsContent value="design">Design panel</TabsContent>
        <TabsContent value="arrange">Arrange panel</TabsContent>
        <TabsContent value="animate">Animate panel</TabsContent>
      </Tabs>
      <Accordion type="single" collapsible>
        <AccordionItem value="a">
          <AccordionTrigger>Can I self-host?</AccordionTrigger>
          <AccordionContent>Yes.</AccordionContent>
        </AccordionItem>
      </Accordion>
    </>
  );
}
